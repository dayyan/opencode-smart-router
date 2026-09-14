# Design: tier-fanout-tool

> Binding inputs: `plans/044-tier-fanout-tool.md` @ `047215f` (canonical engineering intent), the change proposal, delta specs `tier-fanout` + `fanout-config`, confirmed pre-proposal decisions (engram #4963). All file:line anchors below were opened and verified against the live tree at design time (2026-09-13); no drift found.

## Technical Approach

One new plugin module, `src/plugin/fanout.ts`, implements a flattened in-process batch: an eligible depth-1 tier child calls a single `fanout` tool; the plugin creates worker sessions as **siblings parented to the root session**, drives them in parallel under per-worker and batch deadlines, and returns one ordered markdown aggregate of typed outcomes. Every lifecycle step reuses the proven `delegate.ts` patterns verbatim in spirit (bounded create, producer registration, tier-model guard, bounded prompt, conditional abort, never delete) without modifying `delegate.ts` or the native `task`/`delegate` guards. Containment state (concurrency counters + circuit breaker) lives in a per-plugin store wired through `PluginContext`, mirroring the existing factory pattern.

## Architecture Overview

```
CONTROL PLANE (eligibility, caps, breaker)          DATA PLANE (per item)
callerSid ──eligibility checks──► tryAcquire(tier)──► session.create(parentID=rootSid, 30s)
    │                                │  (reject: typed outcome, no SDK)   │
    │                                ▼                                    ▼
    │                          fanoutStore counters        registerProducerSession + markFanoutWorker
    │                          (per-tier / global)                      │
    │                                                                session.prompt(model, agent=tier)
    │                                            workerTimeoutMs ──┐  │  ──► extractPromptText
    │                                                                ▼
    └──batch deadline (batchTimeoutMs) ──────────────► Promise.allSettled → aggregate markdown
                                     aborts outstanding (10s bounded) → cleanup → release(tier)
```

- **Control plane**: eligibility (5 checks), config kill switch, cap admission, breaker — all evaluated before any SDK call except cap admission interleaved per item.
- **Data plane**: N independent worker pipelines; each yields a typed outcome; aggregation is order-preserving over input `items`.

## Architecture Decisions

### D-1 — Registration gate derived inside `assembleRuntimeHooks` (no `src/index.ts` change)

**Choice**: compute `enableFanoutTool = ctx.initialConfig.fanout?.enabled === true` inside `assembleRuntimeHooks` (`src/plugin/runtime.ts:81-111`), spreading `fanout` next to `delegate` in the `tool` record.
**Alternatives**: 4th parameter from the composition root — rejected: the delegate gate is computed in `src/index.ts:44-48`, a file outside the plan's in-scope list; deriving from `ctx.initialConfig` (already a parameter-carried field) keeps scope minimal and the gate identical in meaning to the `enableDelegateTool` precedent (`runtime.ts:87-111`).

### D-2 — One module: `createFanoutStore` + `executeFanout` in `src/plugin/fanout.ts`

**Choice**: store and executor co-located; split into `fanout-store.ts` only if the file exceeds ~400 lines (plan escape hatch). Store instance is per-plugin via `createPluginContext` (`src/plugin/context.ts:155-229`), added as `ctx.fanoutStore` — never module-global (plan reviewer note).
**Alternatives**: separate store module from day one — rejected until size forces it; the proposal's affected-areas table lists a single new file.

### D-3 — Breaker qualification (resolves deferred exploration Q2)

**Choice**: a batch is a *qualifying failure* iff it contains ≥1 worker with outcome `timed_out` **or** ≥1 failed abort (abort throwing/timing out during cleanup). `failed` prompts and caller cancellation are **not** qualifying; any non-qualifying batch outcome resets the streak. Matches `fanout-config` spec ("timeout or failed abort") and plan breaker rule.
**Alternatives**: counting `failed` prompts — rejected: transient model errors are already visible per-worker; mixing them into the breaker conflates containment failure with ordinary API failure.

### D-4 — Enable-on-restart, disable-without-restart (resolves deferred exploration Q3)

**Choice**: tool registration is load-time gated on `ctx.initialConfig.fanout?.enabled === true`; `executeFanout` re-reads `ctx.getFreshConfig()` first (same fail-soft refresh pattern as `executeDelegate`, `src/plugin/delegate.ts:155-161`) and rejects typed `disabled` if fresh config disabled it. Enabling requires restart (tool not shipped); disabling is immediate.
**Alternatives**: runtime-only gating (register always) — rejected: default-off must not surface an unusable tool to tier models.

### D-5 — Rejection shapes (resolves deferred exploration Q4; empty-batch per engram #4963)

**Choice**: whole-batch rejections (disabled, breaker open, empty `items`, `items.length > maxWorkersPerBatch`, ineligible caller) return one typed section `## [batch] status=rejected reason=<kind>` with explanatory text and make **zero** SDK calls. Malformed items (unknown tier edge, missing/empty `prompt`) become per-item `## [n] tier=<t> status=rejected` sections in input order, no session created for that item. Duplicate tiers in one batch are allowed — each is an independent worker subject to caps.
**Alternatives**: throwing on malformed items — rejected: one bad item must not sink the batch (partial-result contract).

### D-6 — Cap admission semantics

**Choice**: `maxWorkersPerBatch` is pure batch validation → whole-batch rejection (D-5). Per-tier and global caps are checked per item via `fanoutStore.tryAcquire(tier, cfg)` at admission (shared mutable state across concurrent batches, per `fanout-config` spec); a denied item yields in-place `rejected` with `reason=cap_tier|cap_global` and no session. Counters release in each worker's cleanup `finally`.

### D-7 — Guard interaction: no whitelist, classify as `other`

**Choice**: do NOT add `fanout` to any guard list. `assertNestedDelegationAllowed` matches only `task`/`delegate` (`src/plugin/hooks/tool-guards.ts:70-82`) and `runSubagentGuard` blocks only `task` (`:296-300`), so depth-1 callers pass by design. In `guardBeforeCall` (`tool-guards.ts:302-326` → `src/guard/enforce.ts:58-102`), `fanout` classifies as `"other"` (`src/guard/guards.ts:123-129`); `deliverable_first` cannot fire because `buildGuardPolicy` pins `deliverableSignal: null` (`enforce.ts:26-37`). Each fanout batch consumes 1 tool-call budget unit — intended. Contingency (plan Step 5): if runtime observation shows blocking, add a minimal tool-name whitelist entry for medium/focused/heavy; **STOP** if that requires changing enforcement semantics.

### Supporting decisions

| Decision | Choice | Rationale |
|---|---|---|
| Root parent source | `rootSid = ctx.sessionStore.parentOf(callerSid)` | `parentOf` (`src/router/sessions.ts:244-246`); depth===1 guarantees non-null; null → ineligible (defense) |
| Worker registration | `registerProducerSession(workerSid, tier, cfg)` then `markFanoutWorker(workerSid)` | producer path gives `trivial:false` full enforcement (`sessions.ts:203-213`); marker enables self-exclusion |
| Tier model resolution | `resolveTierModelGuard(activeCfg, tier)` fail-fast | delegate precedent (`delegate.ts:359-389`) — config failure is a per-item `rejected`, never a prompt |
| Worker agents | tier's static agent def (`agent: tier` in prompt body) | agent defs registered `mode:"subagent"` (`src/router/agents.ts:135-142`); no per-attempt reasoning patches (spec: Operational Visibility) |
| No verification | no DoD/grader for workers | out of scope per plan; caller synthesizes and owns results |

## Data Flow

**Caller eligibility** (ALL must hold, else typed rejection before any SDK call — plan Design summary):
1. `ctx.sessionStore.depth(callerSid) === 1` (`sessions.ts:235-241`; parentage recorded at `session.created` via `src/plugin/hooks/session.ts:45-59` → `registerFromSessionCreated`, `sessions.ts:221-229`)
2. `ctx.sessionStore.getTier(callerSid)` ∈ {medium, focused, heavy} (callers are registered by `registerFromChatMessage`, `sessions.ts:267-291` — the only legitimate path)
3. NOT `isProducerSession(callerSid)`, NOT `ctx.graderSessions.has(callerSid)` (`src/plugin/context.ts:130-132`), NOT `isFanoutWorker(callerSid)`
4. `cfg.fanout.enabled === true` (fresh config)
5. `fanoutStore.breakerState() !== "open"`

Policy matrix (hard-coded in `fanout.ts`, keyed by caller tier): medium→{fast}; focused→{fast,light,medium}; heavy→{fast,light,medium}; fast/light→none.

**Worker lifecycle** (per item): `admitted → created(30s) → registered → prompting(workerTimeoutMs) → {completed|failed|timed_out|cancelled} → cleanup → released`. Cleanup copies `cleanupProducerSession` semantics (`delegate.ts:62-118`): clear `changedFileStore`/`guardStore`, `sessionStore.unregister`, conditional `session.abort` with 10s `withTimeout` on non-success only (`delegate.ts:97-117`), **never** `session.delete`; success persists (`:580-585`, `:652` pattern).

**Circuit breaker**: `closed --threshold consecutive qualifying failures--> open --cooldownMs--> half_open --one probe: success→closed | qualifying failure→open-->`. Probe admission is atomic (`tryEnterProbe()`) so simultaneous batches cannot both probe (`fanout-config` spec: Recovery probe).

## File Changes

| # | File | Action | Change |
|---|---|---|---|
| 1 | `src/router/config.types.ts` | Modify | `FanoutConfig` + `RouterConfig.fanout?` (mirror `reasoningPolicy?` convention, `:275-294`); export `DEFAULT_FANOUT_CONFIG` |
| 2 | `src/router/config-validate.ts` | Modify | `validateFanout` section validator called from `validateConfig` (`:52-67`) after `validatePresets` (needs trusted `activePreset`) |
| 3 | `src/router/sessions.ts` | Modify | closure sets `producers`/`fanoutWorkers`; `markFanoutWorker`, `isProducerSession`, `isFanoutWorker`; `unregister` (`:254-259`) deletes from both; no existing signature changes |
| 4 | `src/plugin/fanout.ts` | Create | `createFanoutStore` + `executeFanout` (D-2) |
| 5 | `src/plugin/context.ts` | Modify | `fanoutStore: ReturnType<typeof createFanoutStore>` on `PluginContext` (`:72-139`) + factory wiring (`:215-225`) |
| 6 | `src/plugin/runtime.ts` | Modify | `fanout` tool next to `delegate` (`:87-111`), gate per D-1; description states matrix, parallelism, fast/light exclusion |
| 7 | `src/plugin/types.ts` | Modify | `FanoutArgs`, `FanoutWorkerStatus`, `FanoutItemResult` (follow `DelegateArgs` precedent, `:23-27`) |
| 8 | `config/tiers/presets.json` | Modify | fanout guidance for medium/focused/heavy; explicit "cannot fan out" line for fast/light |
| 9 | `tiers.json` | Regenerate | `pnpm run build:tiers` |
| 10 | `test/unit/plugin-fanout.test.ts` | Create | see Testing Strategy |
| 11 | `test/unit/sessions.test.ts`, `test/unit/config-validate-sections.test.ts` | Modify | marker tests; fanout block validation cases |
| 12 | `test/integration/nested-delegation-guard.test.ts` | Modify | fanout policy matrix (harness per `:77-180`) |
| 13 | `README.md`, `docs/CONFIG_REFERENCE.md` | Modify | tool section + `fanout` block reference + bounded-response limitation |

No deletions. Out of scope (untouched): `src/plugin/delegate.ts`, `src/plugin/hooks/tool-guards.ts`, `src/verify/*`, `src/reasoning/*`, `src/index.ts`.

## Interfaces / Contracts

```ts
// src/router/config.types.ts
export interface FanoutBreakerConfig { failureThreshold: number; cooldownMs: number }
export interface FanoutConfig {
  enabled?: boolean;                    // default false — kill switch
  maxWorkersPerBatch?: number;          // default 4
  maxConcurrentGlobal?: number;         // default 6
  maxConcurrentPerTier?: Partial<Record<"fast"|"light"|"medium", number>>; // default {fast:4,light:2,medium:1}
  workerTimeoutMs?: number;             // default 120000
  batchTimeoutMs?: number;              // default 180000; must be >= workerTimeoutMs
  breaker?: FanoutBreakerConfig;        // default {failureThreshold:3, cooldownMs:60000}
}
export const DEFAULT_FANOUT_CONFIG: Required<FanoutConfig>;

// src/plugin/types.ts
export interface FanoutArgs { items: Array<{ tier: string; prompt: string }> }
export type FanoutWorkerStatus = "completed" | "failed" | "timed_out" | "cancelled" | "rejected";
export interface FanoutItemResult { index: number; tier: string; status: FanoutWorkerStatus; text: string; reason?: string }

// src/plugin/fanout.ts
export const createFanoutStore = () => ({
  tryAcquire(tier: string, cfg: FanoutConfig): boolean;   // false when per-tier or global cap hit
  release(tier: string): void;
  recordBatchOutcome(qualifyingFailure: boolean, cfg: FanoutBreakerConfig): void; // D-3 streak rule
  breakerState(): "closed" | "open" | "half_open";
  tryEnterProbe(): boolean;                               // atomic half-open admission
});
export const executeFanout = async (
  ctx: PluginContext, args: FanoutArgs, callerSid: string, signal?: AbortSignal,
): Promise<string>;   // aggregate markdown, or "" on caller cancellation (delegate abort contract, delegate.ts:127-146)
```

Aggregate format (plan Step 4): `## [n] tier=<t> status=<s>` sections in input order; batch-level rejection is `## [batch] status=rejected reason=<kind>`.

## Configuration Schema & Validation

`validateFanout(raw)` follows the per-section pattern (`config-validate.ts:52-67`), throwing `tiers.json: fanout …`-prefixed errors on first failure. Rules:
- `enabled` boolean; all numeric limits positive integers.
- `batchTimeoutMs >= workerTimeoutMs` (else reject).
- **Confirmed (engram #4963)**: explicit `maxConcurrentPerTier` keys outside **active-preset tiers ∩ {fast, light, medium}** reject configuration load with a typed error (not silently dropped).
- **Confirmed (engram #4963)**: `fanout({ items: [] })` returns a typed `rejected` outcome — no SDK calls, no silent empty success.

## Telemetry Surface

Structured events via `log`/`logEvent` (`src/utils/observability`, same pattern as `delegate.cleanup_failed` at `delegate.ts:70-75`):

| Event | When |
|---|---|
| `fanout.batch_started` / `fanout.batch_rejected` | admission / each whole-batch rejection (with reason kind) |
| `fanout.worker_completed` / `fanout.worker_failed` | per-worker terminal outcomes |
| `fanout.worker_timed_out` | worker or batch deadline expiry |
| `fanout.abort_failed` | abort threw or exceeded its 10s bound |
| `fanout.unreconciled_worker` | batch returned while a worker's SDK call may still be in flight (accepted limitation surfaced, spec: Lingering worker) |
| `fanout.breaker_opened` / `fanout.breaker_recovered` | breaker transitions |

## Concurrency & Deadline Model

- **Deadline ladder**: `session.create` 30s (`delegate.ts:287-295`), prompt 120s default (`withTimeout` over `session.prompt({ path:{id}, body:{ model, agent: tier, parts:[{type:"text",text}] } })`, shape per `delegate.ts:435-448`), batch 180s default, aborts 10s (`delegate.ts:104-108`). Worker deadline fires before batch deadline for a full wave; the batch timer is the safety net (e.g. create-phase hangs).
- **Batch expiry**: at `batchTimeoutMs`, unfinished workers become `timed_out`, completed text is retained, aborts are **initiated but not awaited** (each internally 10s-bounded), and the aggregate returns at the deadline — response is never delayed past `batchTimeoutMs` (tier-fanout spec). Detached abort settlement updates breaker accounting and emits `fanout.abort_failed`/`fanout.unreconciled_worker` asynchronously.
- **Caller cancellation**: `signal.aborted` checked at loop top, after create, and in prompt catch (checkpoints per `delegate.ts:127-146`, `:254-258`, `:311-317`, `:466-469`); on fire, all outstanding workers receive awaited 10s-bounded aborts, then `""` returns silently. `classifyPromptError` distinguishes abort/non-retryable/retryable.
- **Caps**: single fan-out wave per batch; all `tryAcquire` admissions happen before pipelines start; `release` in each pipeline's `finally` so a crashed worker cannot leak a slot.

## Testing Strategy

| Layer | What | How / Where |
|---|---|---|
| Unit | policy matrix (every edge allowed/denied, denied ⇒ `session.create` mock call count 0), 5 eligibility rules independently, empty batch, malformed items, duplicates | NEW `test/unit/plugin-fanout.test.ts`, `makeCtx` mock style from `test/unit/plugin-delegate.test.ts:84-109` (`createImpl`/`promptImpl`/`abortImpl` spies) |
| Unit | no-grandchild invariant: every create call has `body.parentID === rootSid`, never callerSid | same file |
| Unit | parallelism (both prompts issued before either resolves), worker timeout via fake timers, batch expiry preserves sibling text, cancellation → aborts + `""`, caps (batch/tier/global), breaker open/probe/reopen, cleanup (success persists, failure aborts 10s-bounded, `session.delete` never called), kill switch without SDK calls | same file |
| Unit | marker predicates + unregister cleanup; `fanout` block validation incl. both confirmed decisions | extend `sessions.test.ts`, `config-validate-sections.test.ts` |
| Integration | fanout policy matrix through `handleToolExecuteBefore` harness; depth-0 orchestrator rejected; existing `task`/`delegate` blocks unchanged | extend `test/integration/nested-delegation-guard.test.ts` (`:77-180` harness) |

Gates are baseline-relative (`plans/README.md` cycle-6 note: pre-existing TS2322 + dist-dependent integration tests) — "no NEW failures", plus `pnpm run lint`, `pnpm run build`, `pnpm run test:gate`.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary is introduced. Worker sessions use the existing SDK client surface already exercised by `delegate`; no shell/exec seam is added.

## Migration / Rollout

No migration required. Default-off; rollout = set `fanout.enabled: true` (restart) after the tier prompts teach usage. Rollback: set `enabled: false` (immediate, no restart), then revert the change and regenerate `tiers.json` — successful sessions and delegation guards are preserved.

## Risks & Accepted Limitations

| Risk | Mitigation |
|---|---|
| SDK work outlives bounded response | caps, breaker, detached 10s-bounded aborts, `fanout.unreconciled_worker` telemetry; documented limitation (README); process-isolation backend is the deferred follow-up |
| Root-parenting race/wrong parent | single `parentOf(callerSid)` source; no-grandchild invariant unit test asserts every create |
| Custom-tool invocability from depth-1 child never runtime-proven | STOP condition below (smoke probe before mass code) |
| Breaker/counter cross-batch races | single per-plugin store, synchronous admission, `finally`-released slots, atomic probe entry |
| In-process containment insufficient | accepted for this phase; escalation path = worker-process backend plan |

## STOP Conditions

Mirror `plans/044` STOP conditions — stop and report, do not improvise, if:
- Live code at any anchor above no longer matches the cited excerpts (drift).
- A runtime smoke probe shows a plugin custom tool is NOT invocable from a depth-1 subagent session.
- `session.create` with `parentID = <root sid>` while a tier child is mid-flight fails or hangs.
- `ToolContext` in pinned `@opencode-ai/plugin@1.18.30` lacks `sessionID`/`abort` (contradicts `runtime.ts:105-106`).
- Whitelisting `fanout` in the guard policy (D-7 contingency) requires changing enforcement semantics.
- A step's verification fails twice after a reasonable fix attempt.

## Open Questions

- None blocking. (Cosmetic: exact `fanout` tool description wording and presets.json guidance phrasing — owned by tasks/apply.)
