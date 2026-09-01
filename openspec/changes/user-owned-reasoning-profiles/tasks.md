# Tasks: User-Owned Reasoning Profiles

## Plan consolidation (decision 2026-08-30)

The original 11-WU stacked-to-main split produced excessive friction in
orchestration (one malformed envelope + one wedged ledger per PR is too
much tax for a single feature). **Consolidated to 4 PRs** (option 1 from
the session meta-question). PR #27 (WU-1+WU-2) is already open and stays
as-is. Three new PRs land the remaining work; WU-9 keeps its atomic
non-split boundary per the R-3 coupling mandate.

## Review Workload Forecast (revised)

| Field | Value |
|-------|-------|
| Estimated changed lines | ~2,800 authored (goldens + regenerated `tiers.json` excluded) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Split | **4 stacked PRs** (1 open, 3 remaining) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |
| Size exceptions | Required on PR #28 (consolidated expand) and PR #29 (WU-9 atomic) |

Decision needed before apply: **No** — size exceptions acknowledged
out-of-session, recorded here for the fresh session to label the PRs.

### Bundled-config data table (R-2 — config DATA, never code constants; tests use fixture IDs `p1..p3`)

| Key | Value |
|-----|-------|
| `profiles` | `["light","standard","deep"]` |
| `defaultProfile` | `"standard"` (lifts `adaptive.defaultLevel:"normal"`) |
| `trivialProfile` | `null` |
| Rule remap | `minimal→light`, `elevated→deep`, `max→deep` |
| `fast`/`medium` tiers | no `reasoningControl` |
| `light` (gpt-5.6-luna) | `reasoning.effort`, levels `["low","medium","high","xhigh","max"]`, profileMap `light→low, standard→medium, deep→high`, `maxBumps:0` |
| `focused` (MiniMax-M3) | `variant`, levels `["none","thinking"]`, profileMap `light→none, standard→none, deep→thinking`, `maxBumps:0` |
| `heavy` (gpt-5.6-terra) | `reasoning.effort`, levels `["low","medium","high","xhigh"]`, profileMap `light→low, standard→medium, deep→high`, `maxBumps:0` |

### Consolidated PR plan

| PR | Composed of | ~Lines | Branch | Rollback boundary |
|----|-------------|--------|--------|-------------------|
| **#27** (already open) | WU-1 + WU-2 (expand part 1: v2 types, channel module, D-1 helper, D-4 capability, translate bridge) | ~947 (already landed) | `advisor/041-user-owned-reasoning-profiles` | revert PR 27 — purely additive |
| **#28** (next, size-exception) | Remaining of WU-3..8: full `resolveReasoningProfile` callers + `adaptive-selector.test.ts` rewrite + `ladder.ts` D-2 state + D-3 branches + `delegate.ts` enterTier re-wire + `tool-guards.ts` call-site swap + integration test + commands registry-driven vocab | ~850 (size exception) | same branch, stacked | revert PR 28 — additive; no deletions |
| **#29** (atomic, size-exception, **DO NOT SPLIT**) | WU-9 (R-3): validators rewrite + `base.json` v2 + `presets.json` per-tier control + build-tiers MERGE_PLAN comment + regenerated `tiers.json` + `tiers-assembly.test.ts` + `router-config.test.ts` + `protocol.golden` snapshot | ~550 (size exception, atomic per R-3) | same branch | revert PR 29 — keeps prior config valid |
| **#30** (contract + gate) | WU-10 + WU-11: legacy identifier deletion + anti-hardcoding gate green from first run + docs (REASONING, CONFIG_REFERENCE, ESCALATION, README) | ~450 (size exception) | same branch | revert PR 30 — deletions + gate + docs |

Dependencies: linear stack PR #27 → #28 → #29 → #30. Each PR is reviewable
in isolation. PR #29's atomicity is mandated by R-3 coupling (base.json
flip + validator rewrite + golden snapshot must land together).

### Mapping old WU IDs → new PRs (for grep continuity)

- WU-1, WU-2 → **PR #27** (already open)
- WU-3 (policy.ts), WU-4 (adaptive.ts), WU-5 (ladder.ts D-2/D-3), WU-6 (delegate.ts), WU-7 (tool-guards integration), WU-8 (commands) → **PR #28** (consolidated expand)
- WU-9 → **PR #29** (atomic flip)
- WU-10 (legacy deletion), WU-11 (anti-hardcoding + docs) → **PR #30** (contract + gate)

## Phase 1 (already landed) — PR #27 — Expand part 1

- [x] 1.1 RED+GREEN `reasoning-capability.test.ts` — `channelPatch` × 3 channels; `capability.ts` gains `ReasoningControlChannel`, `REASONING_CONTROL_CHANNELS`, `channelPatch`; legacy exports preserved — commit `510522d`
- [x] 1.2 GREEN `config.types.ts` — `ReasoningProfileId`, `ReasoningControl` (String + Budget variants), `AdaptiveProfileRule`, `ReasoningPolicyConfigV2`, `TierConfig.reasoningControl?`; legacy types untouched (expand phase) — commit `510522d`
- [x] 1.3 RED+GREEN `reasoning-translate.test.ts` — bridge lossless, index clamp at bounds, baseline restore; `translate.ts` adds `resolveControlPatch`/`patchAtIndex`; biome conformance commit — commits `cc367ef` + `f7ad874`
- [x] 1.4 RED+GREEN `reasoning-policy.test.ts` — 20 scenarios for `resolveReasoningProfile` (static/manual/adaptive/unknown-mode, unregistered override, both paths D-1); `policy.ts` adds `resolveReasoningProfile(policy, sessionOverride, signals)` tier-agnostic helper — commit `510522d`
- [x] 1.5 GREEN `adaptive.ts` — `AdaptiveDecisionV2`, `selectAdaptiveLevelV2` (profile ID consequences, same decision order as v1) — commit `510522d`
- [x] tool-guards wiring — `applyOrchestratorReasoningPatch` calls `resolveReasoningProfile` alongside legacy `resolveReasoningOverride` (expand phase); guarded on `"profiles" in v2Policy` to avoid v1 interference — commit `510522d`

## Phase 2 — PR #28 — Expand part 2 (consolidated; size exception required)

- [ ] 2.1 RED+GREEN `adaptive-selector.test.ts` — full rewrite to assert profile-ID consequences (overlaps with WU-1's partial `selectAdaptiveLevelV2`); commit before WU-5 lands so D-3 matrix can reference resolved profile IDs.
- [ ] 2.2 RED+GREEN `ladder.test.ts` `it.each` D-3 matrix (`levels.len 1..5 × maxBumps 0..len−1 × bumpsThisTier × levelIndex × cause`), room formula `min(maxBumps, len−1−startIndex)`, cap/top exhaustion → direct escalate, retryable never bumps. GREEN: `src/escalate/ladder.ts` adds `tierMaxBumps`, `canBumpReasoning(state, verdict)` (**drops unused policy param — flag in PR body**), `bumpExhausted`, branch 5.5.
- [ ] 2.3 RED+GREEN `plugin-delegate.test.ts` — enterTier seeding, bump→bump→escalate, static-tier patch gate, baseline restore. GREEN: `src/plugin/delegate.ts` re-resolves via D-1 helper per tier entry; drops `inferCapability` imports.
- [ ] 2.4 RED+GREEN `test/integration/reasoning-runtime.test.ts` — profile→patch seam per channel at live agent def. GREEN: `src/plugin/hooks/tool-guards.ts` call-sites → `resolveReasoningProfile` + `resolveControlPatch`, logs `reasoning.override_unknown_profile`. Drops the legacy `resolveReasoningOverride` call path.
- [ ] 2.5 RED+GREEN `router-commands.test.ts` + `router-agents.test.ts` — registry-driven vocabulary, unregistered arg rejected, `off` clears; patch/restore parity. GREEN: `builders.ts` (registry vocab, `describeControl`), `dispatch.ts` (registry-only override set).

GREEN throughout: all untouched suites (`config-*`, `ladder-wiring`, `protocol`, `tiers-assembly`, …) stay green on this PR.

## Phase 3 — PR #29 — R-3 atomic flip (single commit, do not split)

- [ ] 3.1 RED: rewrite reasoning sections of `test/unit/config-validate-sections.test.ts` — all fail-fast invariants (profileMap ≠ registry, non-ascending budgets, maxBumps range, missing default, legacy-key errors with migration-doc pointer, invalid reload atomic).
- [ ] 3.2 GREEN: `src/router/config-validate.ts` v2 registry/reference/control validators.
- [ ] 3.3 `config/tiers/base.json`: remove `enforcement.escalate.reasoningEscalation`; v2 `reasoningPolicy` per data table.
- [ ] 3.4 `config/tiers/presets.json`: per-tier `reasoningControl` per data table, ALL `maxBumps:0`, delete `capability` blocks.
- [ ] 3.5 `scripts/build-tiers-config.ts` MERGE_PLAN **comment-only** update (whole-key merge verified, `build-tiers-config.ts:119-148`).
- [ ] 3.6 Regenerate `tiers.json`; update `tiers-assembly.test.ts`, `router-config.test.ts`, `protocol.golden.test.ts.snap` via `vitest -u`; diff review asserts ONLY v2 reasoning shape; jq-check SC-7.

## Phase 4 — PR #30 — Contract + gate (consolidated)

- [ ] 4.1 Delete legacy identifiers: `ReasoningLevel`, `ReasoningCapability`, `POSITIONAL_VARIANTS`, `NAMED_VARIANTS`, `inferCapability`, `translateLevel`, `levelIndexForVariant`, `capabilityLadderLength`, `DISCRETE_RANK`, old `resolveReasoningOverride`, `REASONING_LEVELS`, `detectCollapse`, `ReasoningEscalationConfig`, `EscalatePolicy.reasoningEscalation` + `buildEscalatePolicy` carry.
- [ ] 4.2 Create `test/unit/no-hardcoded-reasoning-vocabulary.test.ts` (banned identifiers + `"minimal"`/`"elevated"` literals in `src/reasoning/`+`src/router/`); MUST pass first run (R-4).
- [ ] 4.3 Update reasoning sections of `docs/REASONING.md`, `docs/CONFIG_REFERENCE.md` (migration note — validator error target), `docs/ESCALATION.md`, `README.md`.

## Process rules for the fresh session

- **Always include explicit `[acceptance]` block** in every sdd-* dispatch prompt (testsPass / buildPasses / fileExists / run checks). The auto-inferred DoD truncates the prompt's first sentence into an unverifiable criterion and false-negatives good work — that bug caused the WU-2 malformed envelope and a wedged ledger. Rule persisted to engram `sdd/user-owned-reasoning-profiles/state` for cross-session continuity.
- PR #28 + #29 carry size exceptions — apply maintainer-approved `size:exception` label on those PRs at open time, do not ask again.
- Runtime ledger: post-reset, `sdd-attempt acquire` returns proceed for new WUs. WU-3's first passing settle in the chain must carry `--remediates-evidence-revision sha256:0000000000000000000000000000000000000000000000000000000000000000` to release the WU-2 incident binding (already noted in engram).
- All work continues on the existing branch `advisor/041-user-owned-reasoning-profiles` on worktree `/tmp/opencode/smart-router-041` from base `0ea3822`. Do not create new branches.
