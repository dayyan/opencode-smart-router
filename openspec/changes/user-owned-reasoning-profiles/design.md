# Design: user-owned-reasoning-profiles

> Binding inputs: `plans/041-user-owned-reasoning-profiles.md` @ `0ea3822` (DECIDED items locked), the four delta specs in this change. Verified against live source at design time. No DECIDED item is re-opened.

## Technical Approach

Replace the code-owned four-grade vocabulary, provider-variant sets, and rank math with two user-owned vocabularies in `tiers.json` — opaque profile IDs (intent) and per-tier native levels (provider truth) — bridged per tier by `reasoningControl.profileMap` and gated by `reasoningControl.maxBumps`. Code never interprets names; array order is the only semantics. The existing pure-function module layout, patch/restore cycle (`agents.ts`, unchanged), and vitest suite boundaries are preserved; only the vocabulary layer and bump-state ownership change.

## Architecture Overview

```
tiers.json ──validate──→ config.types.ts (registry + ReasoningControl types)
                              │
    store.ts (override: string)──→ policy.ts ──resolveReasoningProfile (D-1, tier-agnostic)
                              │        │                                    ▲
                              │   adaptive.ts (selector → profile IDs)      │ SAME helper
                              ▼                                            │
    translate.ts (resolveControlPatch / patchAtIndex ──→ capability.ts channelPatch)
                              │                                            │
    agents.ts applyReasoningPatch (UNCHANGED) ◄── hook path (tool-guards)   │
                              ▲                                            │
                              └── delegate path: enterTier seeds LadderState (D-2)
                                          └──→ ladder.ts nextAction (D-3 exhaustion)
```

Composition: **reasoning-profiles** owns the registry + resolution semantics; **reasoning-control** owns the per-tier bridge from profile ID to native patch; **reasoning-escalation** owns per-tier bump state and exhaustion; **reasoning-config** owns fail-fast invariants, the breaking migration, and the anti-hardcoding regression gate.

## Architecture Decisions

### D-1 — One tier-agnostic resolution helper, two callers

**Choice**: `policy.ts` exports a single pure function; both the task-tool hook and the delegate loop call it.

```ts
export interface ReasoningResolution {
  profile: ReasoningProfileId | null; // null = no patch; static baseline serves
  overrideUnknown: boolean;           // override existed but not in registry
}
export const resolveReasoningProfile = (
  policy: ReasoningPolicyConfig | undefined,
  sessionOverride: string | undefined,
  signals: AdaptiveSignals,           // { prompt, description, tierName, isTrivial }
): ReasoningResolution;
```

**Call sites**: (1) `tool-guards.ts` `applyOrchestratorReasoningPatch` — override from `getOverride(sid)`, signals from task args, then `resolveControlPatch(tier.reasoningControl, res.profile)` → `applyReasoningPatch`; emits `reasoning.override_unknown_profile` when `overrideUnknown`. (2) `delegate.ts` `enterTier` — override from `getOverride(parentSessionID ?? "")`, signals from `normalizeSignalText(args.task)` / `description: ""` / `isTrivial` from the parent session store lookup (fail-soft `false`), `tierName` = tier being entered; re-resolved on every tier entry so `tierProfileDefaults` honors the new tier.

**Why one helper**: the resolver is now tier-agnostic (profile IDs are registry-global; the tier's control maps them later). That is exactly what makes one function serve both callers — the old `resolveReasoningOverride(tier, …)` could not, because it baked the tier's capability into resolution. Mode semantics preserved verbatim: `static` → `{profile:null}`; unknown mode → fail-soft null; `manual` → registered override ?? `defaultProfile`; `adaptive` → registered override → selector → `defaultProfile`. Unregistered override is dropped (`overrideUnknown:true`) and control returns to policy (DECIDED 5/6). Logging stays at call sites — `policy.ts` remains pure.

### D-2 — Per-tier bump state lives in `LadderState`

| Field | Action | Seeding (enterTier) |
|---|---|---|
| `LadderState.levelIndex` | keep | `control.levels.indexOf(control.profileMap[selected])` (defensive `≥0` clamp) |
| `LadderState.bumpsThisTier` | keep | reset 0 on tier change (existing `advance`) |
| `LadderState.reasoningLadderLen` | keep | `control && selected ? control.levels.length : 0` |
| `LadderState.tierMaxBumps` | **add** | `control && selected ? control.maxBumps : 0`; reset 0 in `advance` on escalate |
| `EscalatePolicy.reasoningEscalation` | **remove** | `buildEscalatePolicy` stops carrying it |

`reasoningLadderLen > 0` encodes "control present AND profile selected" (patch-in-play); `tierMaxBumps > 0` additionally encodes "bumping enabled". `canBumpReasoning` stays pure, now state-local: signature drops the unused policy param → `(state, verdict)`, reading `reasoningLadderLen > 0 && tierMaxBumps > 0 && bumpsThisTier < tierMaxBumps && levelIndex < reasoningLadderLen − 1 && verdict?.cause === "verification_fail"`. Seeding `tierMaxBumps: 0` when no profile is selected is what resolves the 4th micro-case without extra state.

### D-3 — Exhaustion branches in `nextAction`

New branch (5.5) shape, with two pure predicates:

```ts
if (canBumpReasoning(state, verdict)) return { action: "bump", … };
if (bumpExhausted(state, verdict)) return escalateOrGiveUp(state, policy, verdict);
// (6) ordinary retry branch — unchanged; (7) escalate/give_up — unchanged
// bumpExhausted = reasoningLadderLen > 0 && tierMaxBumps > 0 && cause === "verification_fail"
```

`bumpExhausted` true + `canBumpReasoning` false ⟺ cap or top exhausted — provable from the two predicate definitions. Exhaustive enumeration (cause `verification_fail`; `retryable_error` always → ordinary retry, bumps untouched):

| # | control | selected | maxBumps | cap / top | Branch | Pinned by |
|---|---|---|---|---|---|---|
| 1 | absent | — | — | — | ordinary retry (6) → (7) | matrix row |
| 2 | present | **null** (4th micro-case: static, unknown mode, dropped override) | any | — | ordinary retry (6) | matrix row |
| 3 | present | yes | 0 | — | ordinary retry (6) | matrix row |
| 4 | present | yes | >0 | room left | **bump** | matrix row |
| 5 | present | yes | >0 | cap exhausted | **escalate directly, no same-level retry** | matrix row |
| 6 | present | yes | >0 | top reached | **escalate directly** | matrix row |

"Property tests" are implemented as **exhaustive enumeration matrices** via `it.each` over the bounded domain (`levels.length ∈ 1..5 × maxBumps ∈ 0..len−1 × bumpsThisTier ∈ 0..maxBumps × levelIndex ∈ 0..len−1 × cause ∈ {verification_fail, retryable_error}`) — fully deterministic, no new dependency (`fast-check` is transitive-only in this repo). Each matrix row asserts the expected `LadderAction`; an aggregate assertion pins effective room `= min(maxBumps, levels.length − 1 − startIndex)`; a sequence test pins bump→bump→escalate flows in `plugin-delegate.test.ts`.

### D-4 — `capability.ts` survives as the channel-only module

**Choice**: keep `src/reasoning/capability.ts` containing ONLY `ReasoningControlChannel` (rename of `ReasoningField`), `REASONING_CONTROL_CHANNELS` (frozen list, consumed by the validator), and `channelPatch(channel, native)` — the single switch mapping channel → `{variant}` / `{options:{reasoning_effort}}` / `{options:{budget_tokens}}`. Delete `ReasoningLevel`, `ReasoningCapability`, `POSITIONAL_VARIANTS`, `NAMED_VARIANTS`, `inferCapability`. `config.types.ts` imports the channel type from here (preserving the existing `config.types → reasoning/capability` dependency direction).

**Alternatives**: move channel constants into `config.types.ts` (rejected — validator would duplicate the literal list or import translate; a dedicated channel module keeps "where each channel writes" in exactly one place and gives `capability.ts` a honest reason to exist).

### Supporting decisions

| Decision | Choice | Rationale |
|---|---|---|
| Resolver returns profile, not patch | tier-agnostic resolution | enables D-1 single-helper; patching is per-tier via that tier's control |
| Patch gate in delegate | `agentDef && control && selected` (replaces `reasoningLadderLen > 0`) | static mode on a control-bearing tier must dispatch unpatched (DECIDED 6) |
| Selector step 4 | returns `null`; `policy.ts` applies `defaultProfile` | `defaultProfile` is policy-level in v2; decision order 1–3 preserved verbatim |
| Legacy `capability` key on tiers | validation error with migration pointer | consistent with legacy-keys-are-errors; no inference (DECIDED 5) |
| `agents.ts` | zero behavioral change | patch applier is already channel-generic (verified `agents.ts:59-76`) |

## Data Flow

Request: `signals + override + policy → resolveReasoningProfile → profile` → hook path: `resolveControlPatch(tier.reasoningControl, profile) → applyReasoningPatch(agentDef)` → restore in after-hook; delegate path: `enterTier` seeds `levelIndex/ladderLen/tierMaxBumps` → per-attempt `patchAtIndex(control, state.levelIndex)` → baseline restored in outer `finally` (unchanged cycle). Verification fail: `verdict.cause → canBumpReasoning/bumpExhausted → bump | escalate | retry`; `recordAttempt` still counts bumped requests toward `maxTotalAttempts`.

## File Changes (dependency order)

| # | File | Action | Change |
|---|---|---|---|
| 1 | `src/router/config.types.ts` | Modify | v2 types (`ReasoningProfileId`, `ReasoningControl`, `AdaptiveProfileRule`, `ReasoningPolicyConfig` w/ `profiles`/`defaultProfile`); `TierConfig.capability` → `reasoningControl?`; delete `ReasoningEscalationConfig` + escalate slot; re-export channel type from `capability.ts` |
| 2 | `src/reasoning/capability.ts` | Modify | channel-only module (D-4) |
| 3 | `src/reasoning/store.ts` | Modify | override type `string` (registry-checked at resolution) |
| 4 | `src/reasoning/adaptive.ts` | Modify | selector returns profile IDs; `AdaptiveDecision.profile`; step 4 → null |
| 5 | `src/reasoning/policy.ts` | Modify | `resolveReasoningProfile` (D-1) |
| 6 | `src/reasoning/translate.ts` | Modify | delete rank math + `translateLevel` + `levelIndexForVariant` + `capabilityLadderLength`; add `resolveControlPatch`, `patchAtIndex` (clamped), delegating to `channelPatch` |
| 7 | `src/escalate/ladder.ts` | Modify | D-2 fields + D-3 branches; `buildEscalatePolicy` drops global block |
| 8 | `src/plugin/delegate.ts` | Modify | `enterTier` reads `reasoningControl` + D-1 resolution; patch gate; delete `inferCapability` imports |
| 9 | `src/router/config-validate.ts` | Modify | registry/reference/control validators; legacy-key errors; `profiles`-required rules; keyword grammar carried over with `profile` |
| 10 | `src/router/commands/builders.ts` | Modify | registry-driven vocabulary; `describeControl`; delete `REASONING_LEVELS` + `detectCollapse` (profileMap is lossless) |
| 11 | `src/router/commands/dispatch.ts` | Modify | override set accepts registry members only; `off` unchanged |
| 12 | `src/plugin/hooks/tool-guards.ts` | Modify | call-site swap to `resolveReasoningProfile` + `resolveControlPatch`; unknown-override log |
| 13 | `config/tiers/base.json` | Modify | remove `reasoningEscalation`; v2 `reasoningPolicy`: `profiles:["light","standard","deep"]`, `defaultProfile:"standard"` (lifts `adaptive.defaultLevel:"normal"`), rules remap `minimal→light`, `elevated|max→deep`, `trivialProfile:null` |
| 14 | `config/tiers/presets.json` | Modify | per-tier `reasoningControl` per plan Step 8; ALL `maxBumps:0`; delete `capability` blocks |
| 15 | `scripts/build-tiers-config.ts` | Modify | MERGE_PLAN **comment-only** update — `enforcement` is merged as a whole top-level key, so nested removal needs no allow-list change (verified: sanity check guards top-level keys only, `build-tiers-config.ts:119-148`) |
| 16 | `tiers.json` | Regenerate | `pnpm run build:tiers` |
| 17 | tests (see below) | Modify/Create | 14 rewritten suites + 1 new |
| 18 | `docs/{REASONING,CONFIG_REFERENCE,ESCALATION}.md`, `README.md` | Modify | v2 schema, migration note (error message target), worked examples |

No files deleted. `src/router/config.ts` barrel needs no edit (`export *` follows config.types). `RouterState.reasoningMode` overlay + `saveReasoningMode` unchanged (mode vocabulary preserved).

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit | resolution per mode, unknown-override drop, selector order/match modes | `reasoning-policy.test.ts`, `adaptive-selector.test.ts` (fixture IDs `p1..p3`, never bundled IDs — R-2) |
| Unit | `resolveControlPatch`/`patchAtIndex` across 3 channels + clamping | `reasoning-translate.test.ts`, `reasoning-capability.test.ts` (channel tests) |
| Unit | D-3 exhaustive matrix, room formula, retryable-never-bumps | `ladder.test.ts` (`it.each` matrices) |
| Unit | enterTier seeding, bump→bump→escalate, patch gate, baseline restore | `plugin-delegate.test.ts` |
| Unit | all validation invariants incl. legacy-key errors, profileMap ≠ registry, non-ascending budgets, maxBumps range | `config-validate-sections.test.ts` |
| Unit | registry-driven command vocabulary, `off` meaning | `router-commands.test.ts`; patch/restore parity `router-agents.test.ts` |
| Integration | profile→patch seam per channel at the LIVE agent def (prompt-seam spy, Plan 034 pattern; STOP if baseline observed) | `test/integration/reasoning-runtime.test.ts` |
| Regression | anti-hardcoding invariant, green from first run (R-4) | NEW `test/unit/no-hardcoded-reasoning-vocabulary.test.ts` |

**R-3 coupling — ONE work unit**: `base.json` removal + `build-tiers-config.ts` comment + `tiers-assembly.test.ts` + `router-config.test.ts` + `protocol.golden.test.ts.snap` + regenerated `tiers.json` land in a single commit (obs #4141). Golden update via `vitest -u`; diff review asserts only v2 reasoning shape; goldens excluded from the authored 400-line count but included in snapshot identity.

**Strict TDD RED-GREEN**: the mapping is mechanical — each spec file's "Test mapping" header names its suites; each `### Requirement` maps to a `describe` block, each `#### Scenario` to one `it` (RED first, then implementation GREEN). The D-3 matrix rows are the escalation spec's scenarios enumerated exhaustively.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary is touched (tier-selection routing is explicitly out of scope; no new process/shell surface).

## Migration / Rollout

- **Breaking, single cutover** inside this change (DECIDED 5 — no feature flag, no runtime inference).
- **Atomic reload**: an invalid v2 document on reload keeps the previously active config (existing config-store behavior, R-1) — covered by a spec scenario in `reasoning-config`.
- **Legacy keys are errors**: `enforcement.escalate.reasoningEscalation` and `TierConfig.capability` fail validation with messages pointing at the migration note in `docs/CONFIG_REFERENCE.md`.
- **Bundled presets ship `maxBumps: 0`** (SC-7, jq-checkable); operators opt in per tier.
- **Rollback**: revert the work-unit commit chain; `tiers.json` is a regenerated artifact, the state-file schema (`reasoningMode`) is unchanged, and session overrides are in-memory — no on-disk data migration to undo.

## Open Questions

- None blocking. (Cosmetic: exact `/model-router-reasoning` help wording — owned by tasks/apply.)
