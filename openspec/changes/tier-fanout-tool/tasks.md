# Tasks: Tier Fanout Tool (Child-Initiated Parallel Delegation)

> Binding inputs: `plans/044-tier-fanout-tool.md` @ `047215f`, design (gatekeeper-PASS), delta specs `tier-fanout` + `fanout-config`, engram #4963. Strict TDD (RED → GREEN) per task. Branch: `advisor/044-tier-fanout-tool`.

## Review Workload Forecast

| Field                       | Value                                |
|-----------------------------|--------------------------------------|
| Estimated changed lines     | ~1,700 (range 1,400–1,900; prod ~560, tests ~1,090, prompts/docs ~125) |
| 400-line budget risk        | High                                 |
| Chained PRs recommended     | Yes                                  |
| Suggested split             | 6 stacked PRs (PR 3 split into 3a/3b to fit the 450-line review budget; no `size:exception` required) |
| Delivery strategy           | auto-chain                           |
| Chain strategy              | stacked-to-main                      |
| Decision needed before apply| No                                   |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Maintainer decision (2026-09-14): the 450-line review budget is held strictly. Original PR 3 (`executeFanout` + tool registration + admission contract tests, ~650 lines) is split into two stacked PRs so neither exceeds the budget: PR 3a registers the tool with a stub executor and ships the admission contract tests against the stub; PR 3b replaces the stub with the real executor. Total PR count: 6.

### Suggested Work Units

| Unit | Goal (start → finish) | Tasks | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|----------------------|-------|-----------|----------------------|-----------------|-------------------|
| 1 | Config block + session markers (baseline → validated `fanout` config, store markers) | 1–3 | PR 1 | `pnpm test -- config-validate-sections sessions` | N/A — no runtime surface until registration (unit-validated) | revert PR 1 — purely additive types/validators/markers |
| 2 | Fanout containment store + ctx wiring | 4 | PR 2 | `pnpm test -- plugin-fanout-store plugin-context` | N/A — store is plugin-internal until tool registers | revert PR 2 — additive store, no behavior change |
| 3a | Tool registration + stub executor + admission contract tests | 5a | PR 3a | `pnpm test -- plugin-fanout` | STOP-gated smoke probe (Step 5): custom tool invocable from depth-1 child | revert PR 3a — tool unregistered by default; stub returns `rejected` only |
| 3b | Real `executeFanout` + admission behavior tests (parallelism, root parenting, happy aggregation) | 5b | PR 3b | `pnpm test -- plugin-fanout` | STOP-gated smoke probe (Step 5): `session.create(parentID=root)` mid-flight works | revert PR 3b — tool unregistered by default; no behavioral change beyond stub |
| 4 | Containment tests: deadlines, cancellation, caps, breaker, cleanup | 6 | PR 4 | `pnpm test -- plugin-fanout` | N/A — test-only slice over PR 3b source | revert PR 4 — coverage only |
| 5 | Integration matrix + tier prompts + docs + final gates | 7–10 | PR 5 | `pnpm test -- nested-delegation-guard` | Optional post-merge probe: set `fanout.enabled`, dispatch a medium child, verify tool discovery | revert PR 5 — prompts/docs only; guards untouched |

Stack: PR 1 → PR 2 → PR 3a → PR 3b → PR 4 → PR 5, each merging to main in order on `advisor/044-tier-fanout-tool`.

## Task List

- [x] **Task 1 — Capture verification baseline (Step 0)** — no repo files; run `pnpm install && pnpm run typecheck && pnpm test && pnpm run lint` on clean tree, record pre-existing failures (TS2322 `ladder.test.ts`; 3 dist-dependent integration tests) to /tmp/opencode/044-baseline.txt (scratch, outside repo). Verify: baseline file exists. Commit: none. Deps: —. ~0 lines.

- [x] **Task 2 — Add `FanoutConfig` types + strict validation (Step 1)** — Files: `src/router/config.types.ts`, `src/router/config-validate.ts`, `test/unit/config-validate-sections.test.ts`.
  **RED**: validation cases — defaults resolve; non-positive numeric limits rejected; `batchTimeoutMs < workerTimeoutMs` rejected; explicit `maxConcurrentPerTier` key outside active-preset ∩ {fast,light,medium} → typed load error (engram #4963); valid explicit keys pass; `enabled` non-boolean rejected (spec: fanout-config/Invalid configuration).
  **GREEN**: `FanoutBreakerConfig`/`FanoutConfig`/`DEFAULT_FANOUT_CONFIG` + `RouterConfig.fanout?` mirroring `reasoningPolicy?` (`config.types.ts:275-294`); `validateFanout` section validator after `validatePresets` — needs trusted `activePreset` (`config-validate.ts:52-67` pattern).
  **Verify**: `pnpm test -- config-validate-sections` → new cases pass, no NEW failures vs baseline. Commit: `feat(config): add fanout block types with strict validation`. Deps: 1. ~170 lines.

- [x] **Task 3 — Session-store caller-kind markers (Step 2)** — Files: `src/router/sessions.ts`, `test/unit/sessions.test.ts`.
  **RED**: `markFanoutWorker` + `isFanoutWorker` predicate; `isProducerSession` true after `registerProducerSession`; `unregister` (`sessions.ts:254-259`) removes from both sets; no existing signature/behavior change.
  **GREEN**: closure sets `producers` (populated by `registerProducerSession`, `sessions.ts:203-213`) and `fanoutWorkers`; new methods added without touching existing ones.
  **Verify**: `pnpm test -- sessions` → existing + new marker tests pass. Commit: `feat(router): add producer and fanout-worker session markers`. Deps: 1. ~90 lines.

- [x] **Task 4 — Fanout containment store + context wiring (Step 3)** — Files: `src/plugin/fanout.ts` (new), `src/plugin/context.ts`, `src/plugin/types.ts`, `test/unit/plugin-fanout.test.ts` (new).
  **RED**: store tests — `tryAcquire`/`release` per-tier and global caps; breaker streak (qualifying failure = `timed_out` OR failed abort, D-3), non-qualifying reset; `closed→open→half_open` transitions; `tryEnterProbe` atomicity under simultaneous calls (spec: fanout-config/Recovery probe).
  **GREEN**: `createFanoutStore()` per design Interfaces contract; `FanoutArgs`/`FanoutWorkerStatus`/`FanoutItemResult` in `types.ts` (follow `DelegateArgs` `types.ts:23-27`); `fanoutStore` field + factory in `createPluginContext` (`context.ts:72-139`, `:215-225`) — per-plugin, never module-global.
  **Verify**: `pnpm run typecheck` no NEW errors; `pnpm test -- plugin-fanout` store suite passes. Commit: `feat(plugin): add fanout containment store and context wiring`. Deps: 2. ~290 lines.

- [x] **Task 5a — Tool registration + stub executor + admission contract tests (Step 4 part 1)** — Files: `src/plugin/fanout.ts` (new — stub executor only), `src/plugin/runtime.ts` (registration), `test/unit/plugin-fanout.test.ts` (new — admission contract tests against the stub), `src/plugin/types.ts` (`FanoutArgs` + outcome types).
  **RED**: admission contract — every denied edge (fast/light→any, medium→light/medium, focused→heavy, heavy→heavy) rejects with `session.create` mock call count 0; each of the 5 eligibility rules (depth===1 via `sessions.ts:235-241`, caller tier, producer/grader/worker exclusion via `context.ts:130-132`, fresh `enabled`, breaker closed) rejects independently; empty `items: []` → typed `rejected`, zero SDK calls (engram #4963, spec: tier-fanout/Empty batch); kill switch — fresh-config disable → typed rejection, no SDK (spec: fanout-config/Disable without restart); tool schema accepts `{ items: Array<{ tier, prompt }> }`; `enabled: false` means tool absent from runtime tool list.
  **GREEN (stub)**: `executeFanout` is implemented as a stub that runs the admission gate (depth/tier/producer/grader/worker/breaker/empty) and returns typed `rejected` for every non-passing case. Allowed edge also returns typed `rejected` at this stage (real executor is PR 3b). Tool registration in `runtime.ts:81-111` (D-1): gate `enableFanoutTool = ctx.initialConfig.fanout?.enabled === true`, tool description states matrix, parallelism, fast/light exclusion.
  **Verify**: `pnpm test -- plugin-fanout` → admission tests pass; `pnpm run lint` clean (no import-order regressions). Commit: `feat(plugin): register fanout tool with stub executor and admission gate`. Deps: 4. ~300 lines.

- [x] **Task 5b — Real `executeFanout` + admission behavior tests (Step 4 part 2)** — Files: `src/plugin/fanout.ts` (replace stub with real executor), `test/unit/plugin-fanout.test.ts` (behavior tests against real executor).
  **RED**: policy matrix — every allowed edge (medium→fast; focused/heavy→fast,light,medium) now creates sessions (stub previously rejected them); **no-grandchild invariant**: every create call has `body.parentID === rootSid` (`parentOf`, `sessions.ts:244-246`), never callerSid; parallelism — both prompts issued before either resolves; `items.length > maxWorkersPerBatch` → whole-batch typed `rejected`; malformed items (unknown tier edge, empty prompt) → per-item `rejected`, siblings unaffected; ordered `## [n] tier=<t> status=<s>` aggregation; success path persists worker text, never calls `session.delete`.
  **GREEN**: `executeFanout(ctx, args, callerSid, signal)` per design Data Flow — re-read `ctx.getFreshConfig()` first (D-4); reuse delegate patterns: create 30s (`delegate.ts:287-295`), `registerProducerSession` + `markFanoutWorker` (`:334`), `resolveTierModelGuard` fail-fast (`:359-389`), prompt shape `model`+`agent: tier` (`:435-448`), cleanup semantics (`:62-118`), abort contract → `""` (`:127-146`); acquire/release fanout store slots in `finally`.
  **Verify**: `pnpm test -- plugin-fanout` → all behavior tests pass; no NEW failures vs baseline; `rtk grep -n 'session.delete' src/plugin/fanout.ts` → no matches. Commit: `feat(plugin): implement fanout executor with root-parented parallel workers`. Deps: 5a. ~430 lines (tight).

- [x] **Task 6 — Containment tests: deadlines, cancellation, caps, cleanup, telemetry (Step 4 test plan)** — Files: `test/unit/plugin-fanout.test.ts` (+ `src/plugin/fanout.ts` only if tests expose gaps).
  **RED (fake timers)**: worker timeout — hung prompt → `timed_out`, `session.abort` called, completed sibling text preserved (spec: tier-fanout/Partial timeout); batch expiry — aggregate returns by `batchTimeoutMs`, completed retained, aborts initiated-not-awaited, `fanout.unreconciled_worker` + `fanout.abort_failed` emitted (spec: tier-fanout/Lingering worker); cancellation — signal mid-batch → all outstanding aborted (10s-bounded), return `""` (spec: tier-fanout/Terminal cleanup); per-tier + global caps exhausted → in-place `rejected` (`reason=cap_tier|cap_global`), no session (spec: fanout-config/Exhausted capacity); breaker batch-level — `failureThreshold` consecutive → `circuit_open`; cooldown → exactly one probe; success closes, qualifying failure reopens; cleanup — success persists with no abort, failure aborts 10s-bounded, `session.delete` mock NEVER called; counters released in `finally`.
  **Verify**: `pnpm test -- plugin-fanout` → full suite green. Commit: `test(plugin): cover fanout deadlines, cancellation, caps, and breaker`. Deps: 5. ~350 lines.

- [x] **Task 7 — Guard-interaction verification + integration matrix (Step 5)** — Files: `test/integration/nested-delegation-guard.test.ts`. Read-only verification: `src/guard/enforce.ts` (read-only), `src/guard/guards.ts` (read-only), `src/plugin/hooks/tool-guards.ts` (read-only — NEVER modified; `fanout` must classify as `"other"`, D-7).
  **RED**: through `handleToolExecuteBefore` harness (`:77-180`) — depth-1 medium caller allowed; fast/light caller, fanout worker, delegate producer, grader session, depth-0 orchestrator all rejected; existing `task`/`delegate` descendant blocks unchanged (existing tests stay green). If `fanout` is blocked: minimal tool-name whitelist entry only — STOP if it requires enforcement-semantics changes.
  **Verify**: `pnpm test -- nested-delegation-guard` → all pass. Commit: `test(integration): assert fanout policy matrix and unchanged nesting guards`. Deps: 5. ~100 lines.

- [x] **Task 8 — Tier prompt guidance (Step 6)** — Files: `config/tiers/presets.json` (source of truth), `tiers.json` (regenerated only).
  **GREEN**: medium/focused/heavy prompts gain a fanout usage block (when to use, caller-tier matrix, single batch-call example); fast/light prompts gain "You cannot fan out; do not call the fanout tool." Regenerate via `pnpm run build:tiers` — never hand-edit `tiers.json`.
  **Verify**: `pnpm run build` → exit 0; `git status` shows `tiers.json` regenerated. Commit: `feat(tiers): add fanout guidance to tier prompts`. Deps: 5. ~50 lines.

- [x] **Task 9 — Documentation (Step 7)** — Files: `README.md`, `docs/CONFIG_REFERENCE.md`.
  **GREEN**: README section "Child-initiated fan-out (`fanout` tool)" — purpose, policy matrix, config block, explicit limitation "bounded response, not guaranteed worker termination; native nesting stays blocked"; `CONFIG_REFERENCE.md` `fanout` block reference incl. strict `maxConcurrentPerTier` key validation.
  **Verify**: `pnpm run lint` → exit 0. Commit: `docs: document the fanout tool and configuration`. Deps: 5, 8. ~75 lines.

- [x] **Task 10 — Final gates + plan status (done criteria)** — Files: `plans/README.md` (plan-mandated status row only). Verification: `pnpm run typecheck`, `pnpm test`, `pnpm run test:res`, `pnpm run lint`, `pnpm run build`, `pnpm run test:gate` — all no NEW failures vs Task-1 baseline, coverage holds; `rtk grep -n '"fanout"' src/plugin/hooks/tool-guards.ts` → no matches; `rtk grep -n 'session.delete' src/plugin/fanout.ts` → no matches; `git status` shows no files outside in-scope list. Commit: `docs(plans): mark plan 044 complete`. Deps: 2–9. ~3 lines.

## Scenario Coverage Map

| Spec scenario | Task |
|---|---|
| tier-fanout: Eligibility matrix | 5a (denied edges + 5 rules), 5b (allowed edges + parallelism), 7 |
| tier-fanout: Empty batch | 5a |
| tier-fanout: Overlapping siblings | 5b |
| tier-fanout: Partial timeout | 6 |
| tier-fanout: Terminal cleanup | 6 |
| tier-fanout: Lingering worker | 6 |
| fanout-config: Disable without restart | 5a |
| fanout-config: Invalid configuration | 2 |
| fanout-config: Exhausted capacity | 5b (batch), 6 (tier/global) |
| fanout-config: Recovery probe | 4, 6 |

## Binding STOP Conditions & Invariants (from plan 044 + design)

- NEVER add `fanout` to `task`/`delegate` guards in `src/plugin/hooks/tool-guards.ts`; NEVER modify `src/plugin/delegate.ts`, `src/verify/*`, `src/reasoning/*`, `src/index.ts`.
- Workers always `parentID = rootSid` (caller's parent) — never caller sid; no-grandchild invariant is asserted per batch.
- NEVER call `session.delete`; abort-only cleanup, 10s-bounded, non-success only; success persists.
- `items: []` → typed `rejected`, zero SDK calls; unknown `maxConcurrentPerTier` keys → typed config-load error (engram #4963).
- Tier guidance flows `config/tiers/presets.json` → `pnpm run build:tiers` → `tiers.json` only.
- Runtime STOP probes before mass code: custom tool invocable from depth-1 child; root-parented `session.create` mid-flight works. Drift vs design anchors or 2× failed verification → stop and report.
