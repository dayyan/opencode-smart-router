# Plan 034: Add reasoning-level escalation on retry (bump before tier fallback)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7064e0d..HEAD -- src/escalate/ladder.ts src/reasoning/translate.ts src/reasoning/capability.ts src/router/config.types.ts src/router/config-validate.ts src/plugin/delegate.ts src/router/agents.ts test/unit/ladder.test.ts test/unit/reasoning-translate.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction (feature)
- **Planned at**: commit `7064e0d`, 2026-08-09

## Why this matters

Today, when a delegated task fails verification, the router's escalation
ladder (`src/escalate/ladder.ts`) either **retries the same tier at the same
reasoning level** (`maxAttemptsPerTier`) or **escalates to the next tier** (a
different, more expensive *model*). It never tries the current tier *harder*.

For a tier backed by a reasoning-capable model that exposes a multi-rung
ladder (e.g. `[low, medium, high, xhigh, max]` via `reasoning.effort`, or
`[default, thinking]` via `variant`), failing at `medium` should bump to
`high`, then `xhigh`, **before** paying to jump tiers. This keeps delegations
on the cheaper tier longer when a little more reasoning effort would have
sufficed.

The bump ladder is **pure data** — it comes from each tier's
`capability.levels` in `tiers.json`, advanced by index. It survives providers
renaming or reshaping their rungs (e.g. a model going
`[low,medium,high,max]` → `[default,high,max]`, or dropping reasoning
entirely) via a config edit, with **no code change**. Tiers with no reasoning
control (`capability.kind: "none"`) skip straight to tier escalation exactly
as today.

## Current state

### Files and their roles

- `src/escalate/ladder.ts` — **the integration point**. Holds `EscalatePolicy`,
  `LadderState`, `nextAction()` (the retry/escalate decision), `advance()`
  (state transitions), and `buildEscalatePolicy()` (reads
  `cfg.enforcement.escalate`).
- `src/reasoning/translate.ts` — `translateLevel(cap, level)` maps a normalized
  `ReasoningLevel` to a provider patch. Computes a provider ladder index
  internally but does **not** expose it.
- `src/reasoning/capability.ts` — `ReasoningCapability` type
  (`none | binary | discrete | budgeted`) and `inferCapability(tier)`.
- `src/router/config.types.ts` — `EnforcementConfig` (has the `escalate`
  block), `TierConfig` (has `capability?`).
- `src/router/config-validate.ts` — `validateEnforcementEscalate()` validates
  the `enforcement.escalate` block.
- `src/plugin/delegate.ts` — `executeDelegate()`, the retry/escalate loop.
  Calls `session.prompt({ body: { model, agent: tier, parts } })` per attempt.
- `src/router/agents.ts` — `registerTierAgents()` bakes each tier's static
  `variant`/`options` into `opencodeConfig.agent[name]`;
  `applyReasoningPatch(agentDef, resolved)` mutates variant/options in place;
  `restoreAgentBaseline(agentDef, baseline)` restores.
- `test/unit/ladder.test.ts` — pattern for ladder unit tests (uses
  `makePolicy`/`makeState` helpers + a property-based termination test).

### Key current-state excerpts

**`EscalatePolicy` and `LadderState`** (`src/escalate/ladder.ts:10-25`):
```ts
export interface EscalatePolicy {
  ladder: string[];
  floorTier?: string | null;
  maxAttemptsPerTier: number;
  maxTotalAttempts: number;
  costMultiple?: number | null;
}

export interface LadderState {
  currentTier: string;
  attemptsThisTier: number;
  totalAttempts: number;
  escalations: number;
  firstAttemptCost: number | null;
  cumulativeCost: number;
}
```

**`nextAction` decision order** (`src/escalate/ladder.ts:95-153`) — today it is:
(1) pass → accept; (2) abort → give_up; (3) cost; (4) max total → give_up;
(5) cost ceiling → give_up; (6) `attemptsThisTier < maxAttemptsPerTier` →
retry; (7) escalate or give_up.

**`translateLevel` discrete index math** (`src/reasoning/translate.ts:65-75`):
```ts
case "discrete": {
  const target = DISCRETE_RANK[level];                 // minimal0 normal1 elevated2 max3
  const rawIdx = Math.round((target / 3) * (cap.levels.length - 1));
  const idx = Math.min(rawIdx, cap.levels.length - 1);
  const picked = cap.levels[idx];
  ...
}
```
The `idx` is computed but discarded — this plan exposes it.

**`ReasoningCapability`** (`src/reasoning/capability.ts:44-52`):
```ts
export type ReasoningCapability =
  | { kind: "none" }
  | { kind: "binary"; field: "variant"; baseline?: string; elevated: string }
  | { kind: "discrete"; field: "variant" | "reasoning.effort"; levels: string[] }
  | { kind: "budgeted"; field: "thinking.budgetTokens"; recommended: Record<ReasoningLevel, number> };
```

**`EnforcementConfig.escalate`** (`src/router/config.types.ts:86-92`):
```ts
escalate?: {
  floorTier?: string | null;
  ladder?: string[];
  maxAttemptsPerTier?: number;
  maxTotalAttempts?: number;
  costCeiling?: { base?: string; multiple?: number };
};
```

**delegate loop calls `session.prompt` with `agent: tier`** (`src/plugin/delegate.ts:335-348`),
and `nextAction` + `advance` at `delegate.ts:465-524`. The producer's reasoning
level comes from the **static agent def** (`opencodeConfig.agent[tier]`)
registered by `registerTierAgents` — the delegate loop itself never patches
reasoning today.

### How a bumped level reaches the producer (the wiring contract)

`registerTierAgents` (`src/router/agents.ts:112-156`) writes the tier's
`variant` + `options` into the **live** `opencodeConfig.agent[name]`. When
`executeDelegate` calls `session.prompt({ body: { agent: tier } })`, opencode
reads that same live def. Therefore calling
`applyReasoningPatch(ctx.opencodeConfig.agent[tier], patch)`
(`src/router/agents.ts:59-76`) **before** the prompt overwrites the variant the
producer will run with. This is the same mechanism the existing
`applyOrchestratorReasoningPatch` hook uses for the `task` tool path. The bump
feature reuses it inside the delegate loop.

### Conventions to match

- **Pure helpers, no IO**: `ladder.ts` and `translate.ts` are pure functions
  with `...state` spread returns (immutable state transitions). Match this —
  see `recordAttempt` (`ladder.ts:67-74`) and `advance` (`ladder.ts:155-170`).
- **Config validation**: every sub-validator throws with a `tiers.json: …`
  prefix on first failure. Match `validateEnforcementEscalate`
  (`config-validate.ts:263-304`). Permissive-skip policy: a missing block is a
  no-op; a present-but-malformed block throws.
- **Tests**: vitest, `describe`/`it`/`expect`. Use the `makePolicy`/`makeState`
  helpers in `test/unit/ladder.test.ts:33-54` as the structural pattern.
- **Comments**: the repo uses dense JSDoc/section headers explaining *why*
  (see the file headers in `ladder.ts`). Match that style for new public
  functions. Per repo convention, do not add throwaway inline comments.

### Design decisions (locked with the maintainer — honor these)

1. **Bump ladder is pure data from `capability.levels`, advanced by INDEX.**
   Never hardcode level names. `discrete` → use `levels[]`; `binary` → treat as
   a 2-rung ladder `[baseline, elevated]`; `none` and `budgeted` → no bump
   (straight to tier escalation). This is what makes the feature survive
   provider ladder changes.
2. **Escalation suffix = rungs ABOVE the starting level.** The starting index
   is derived from the tier's configured variant/effort in `tiers.json`
   (`levelIndexForVariant`). Bumps advance `startIndex+1, +2, …`. If the start
   is already the top rung, the suffix is empty → escalate immediately.
3. **Cap N=2 bumps per tier by default** (`maxLevelBumpsPerTier`), then
   escalate tier. When the feature is enabled and a tier has a usable ladder,
   bumps **replace** same-level retries for that tier (one attempt per level).
   Tiers with no ladder keep the existing `maxAttemptsPerTier` retries.
4. **Trigger = verification FAIL only.** Retryable errors (429/transport) and
   non-retryable errors already take separate paths in `delegate.ts` and must
   NOT bump (more reasoning won't fix a rate limit).
5. **`maxTotalAttempts` and `costMultiple` ceilings still bind** — every bump
   is one `recordAttempt`, so the existing caps bound total cost.

## Commands you will need

| Purpose   | Command                                  | Expected on success |
|-----------|------------------------------------------|---------------------|
| Install   | `pnpm install`                           | exit 0              |
| Typecheck | `pnpm typecheck`                         | exit 0, no errors   |
| Lint      | `pnpm lint`                              | exit 0              |
| Tests     | `pnpm test`                              | all pass            |
| One suite | `pnpm test -- ladder`                    | all pass            |
| Build     | `pnpm build`                             | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/router/config.types.ts` — add `ReasoningEscalationConfig`, attach to `escalate`.
- `src/router/config-validate.ts` — validate the new block.
- `src/reasoning/translate.ts` — add index helpers.
- `src/escalate/ladder.ts` — extend `LadderState`/`EscalatePolicy`/`nextAction`/`advance`/`buildEscalatePolicy`.
- `src/plugin/delegate.ts` — wire per-attempt patching + bump handling + baseline restore.
- `test/unit/ladder.test.ts` — extend helpers, add bump tests.
- `test/unit/reasoning-translate.test.ts` — add index-helper tests (create if absent; otherwise model after an existing reasoning test).
- `test/unit/plugin-delegate.test.ts` — add a bump-then-tier integration test (if this file exists; otherwise add to the closest existing delegate test).

**Out of scope** (do NOT touch, even though they look related):
- `src/plugin/hooks/tool-guards.ts` — the `task`-tool reasoning patch path. This feature is about the **delegate** ladder only; do not change the `task` path.
- `tiers.json` / `config/tiers/presets.json` — do NOT change any tier's `capability`/`variant` in this plan. (The maintainer noted M3 is correctly `binary` `[default, thinking]`; no redeclaration is wanted here.)
- `src/reasoning/policy.ts`, `src/reasoning/adaptive.ts` — the bump starts from the tier's **static** configured variant. Wiring adaptive/manual policy resolution into the delegate loop is a separate, larger change (note it in Maintenance notes, do not implement).
- The `budgeted` capability — no bump support in v1 (treat like `none`).
- Public response shapes, the `task` tool, agent registration (`registerTierAgents`).

## Git workflow

- Branch: `advisor/034-reasoning-bump-escalation`
- Commit per logical step (config, translate, ladder, delegate, tests). Message
  style: conventional commits, e.g. `feat(escalate): add reasoning-level bump
  before tier fallback`. Check `git log --oneline -10` to confirm style.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the config type

In `src/router/config.types.ts`:

1. Add a new interface near `EnforcementConfig`:
   ```ts
   export interface ReasoningEscalationConfig {
     /** Master switch. When false/absent the feature is off (current behavior). */
     enabled?: boolean;
     /** Max reasoning-level bumps per tier before falling back to the next tier. Default 2. */
     maxLevelBumpsPerTier?: number;
   }
   ```
2. Add `reasoningEscalation?: ReasoningEscalationConfig;` to the `escalate`
   block inside `EnforcementConfig` (`config.types.ts:86-92`).

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Validate the new block

In `src/router/config-validate.ts`, inside `validateEnforcementEscalate`
(`config-validate.ts:263-304`), add (matching the permissive-skip +
`tiers.json:` prefix style):

- `escalate.reasoningEscalation`, if present, must be a plain object.
- `enabled`, if present, must be a boolean.
- `maxLevelBumpsPerTier`, if present, must be an integer `>= 0`.

Throw `tiers.json: enforcement.escalate.reasoningEscalation…` messages on
violation. Call a new `validateReasoningEscalation(escalate)` helper from
`validateEnforcementEscalate` (after the existing `validateEscalateCostCeiling`
call at `config-validate.ts:268`).

**Verify**: `pnpm test -- config` → all pass; then add a quick manual check by
temporarily setting `reasoningEscalation: { enabled: "yes" }` in a scratch
config is NOT required — instead confirm existing config tests still pass and
typecheck is clean.

### Step 3: Expose ladder-index helpers in translate.ts

In `src/reasoning/translate.ts`, add these pure helpers alongside
`translateLevel` (reuse the existing `DISCRETE_RANK` map):

- `resolveLevelIndex(cap, level): number | null` — the starting index for a
  `ReasoningLevel` under a capability. `discrete` → same math as
  `translateLevel`'s `idx`; `binary` → `elevated|max ? 1 : 0`; `none`/`budgeted`
  → `null`.
- `levelIndexForVariant(cap, variant): number` — index of a provider variant
  string in the ladder. `discrete` → `cap.levels.indexOf(variant)` (clamped to
  `>= 0`); `binary` → `variant === cap.elevated ? 1 : 0`; `none`/`budgeted` →
  `0`.
- `translateAtIndex(cap, idx): ResolvedReasoning` — the patch for a given
  index. `discrete` → pick `cap.levels[idx]` and route by `cap.field`
  (variant or `reasoning_effort`); `binary` → `idx >= 1 ? { variant: elevated }
  : (baseline ? { variant: baseline } : null)`; `none`/`budgeted` → `null`.
- `capabilityLadderLength(cap): number` — `discrete` → `cap.levels.length`;
  `binary` → `2`; `none`/`budgeted` → `0`.

Keep `translateLevel` working unchanged (it can delegate to
`translateAtIndex(cap, resolveLevelIndex(cap, level))` — but only if that is
demonstrably equivalent; otherwise leave it as-is and add the helpers
separately).

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Extend the ladder state, policy, and decision

In `src/escalate/ladder.ts`:

1. **`EscalatePolicy`** (`ladder.ts:10-16`): add
   `reasoningEscalation?: { enabled?: boolean; maxLevelBumpsPerTier?: number }`.
   In `buildEscalatePolicy` (`ladder.ts:172-181`), read it from
   `cfg.enforcement?.escalate?.reasoningEscalation` with defaults
   `{ enabled: false, maxLevelBumpsPerTier: 2 }` when absent (so existing
   behavior is unchanged unless explicitly enabled).

2. **`LadderState`** (`ladder.ts:18-25`): add three fields:
   - `levelIndex: number` — current index in the tier's capability ladder.
   - `bumpsThisTier: number` — reasoning bumps performed on the current tier.
   - `reasoningLadderLen: number` — length of the current tier's capability
     ladder (0 for `none`/`budgeted`).
   Initialize all to `0` in `newLadderState`. (They are recomputed by the
   delegate loop's `enterTier` helper — see Step 5 — so the zero defaults are
   just safe placeholders.)

3. **`LadderActionKind`** (`ladder.ts:27`): add `"bump"`.

4. **`nextAction`** (`ladder.ts:95-153`): insert a new branch **between** the
   existing retry branch (6) and the escalate branch (7). The bump fires when
   reasoning escalation is enabled AND the tier has a usable ladder AND rungs
   remain above the current index AND the bump cap is not hit:
   ```ts
   const re = policy.reasoningEscalation;
   const bumpEnabled = re?.enabled === true;
   const tierHasLadder = state.reasoningLadderLen > 0;
   const rungsRemain = state.levelIndex < state.reasoningLadderLen - 1;
   const cap = re?.maxLevelBumpsPerTier ?? 2;
   const bumpsLeft = state.bumpsThisTier < cap;
   if (bumpEnabled && tierHasLadder && rungsRemain && bumpsLeft) {
     return { action: "bump", tier: state.currentTier,
              forcingMessage: buildLadderForcingMessage(verdict?.reasons ?? []) };
   }
   ```
   **IMPORTANT ordering**: when `bumpEnabled && tierHasLadder` but bumps are
   exhausted (no rungs remain OR cap hit), SKIP the existing same-level retry
   branch for this tier and fall through to escalate. Encode this so ladder
   tiers under the feature bump-then-escalate (one attempt per level), while
   non-ladder tiers (`reasoningLadderLen === 0`) keep the existing
   `maxAttemptsPerTier` retry path unchanged. The existing retry branch (6)
   must still run for `tierHasLadder === false` / feature-off cases.

5. **`advance`** (`ladder.ts:155-170`): add a `"bump"` case that returns
   `{ ...state, levelIndex: state.levelIndex + 1, bumpsThisTier: state.bumpsThisTier + 1 }`.
   The `"escalate"` case must additionally reset `levelIndex: 0`,
   `bumpsThisTier: 0`, `reasoningLadderLen: 0` (the delegate loop re-populates
   these for the new tier in Step 5).

6. Add a small exported pure helper `canBumpReasoning(state, policy): boolean`
   factoring the bump-condition above, so it is unit-testable in isolation.

**Verify**: `pnpm typecheck` → exit 0; `pnpm test -- ladder` → all existing
tests still pass (the test helpers need updating first — do that in Step 6, but
the existing suite must not regress).

### Step 5: Wire the delegate loop

In `src/plugin/delegate.ts`. This is the largest step; make changes in this
order so the codebase is never broken between sub-steps.

1. **Imports**: add `applyReasoningPatch`, `restoreAgentBaseline` from
   `../router/agents`; add the new translate helpers
   (`translateAtIndex`, `levelIndexForVariant`, `capabilityLadderLength`) and
   `inferCapability` from reasoning; add `canBumpReasoning` from ladder. Add a
   new import of the `bump` action handling.

2. **`enterTier` helper** (new local function inside `executeDelegate`'s scope,
   or a module-level pure helper taking `state`, `tier`, `tierConfig`): given
   the tier just entered, resolve `cap = tierConfig.capability ?? inferCapability(tierConfig)`,
   set `state.levelIndex = levelIndexForVariant(cap, tierConfig.variant ?? tierConfig.reasoning?.effort)`,
   `state.reasoningLadderLength = capabilityLadderLength(cap)`, keep
   `bumpsThisTier` as `advance` already reset it. Call this right after
   `newLadderState` (for the initial tier) and after each `escalate` `advance`
   (for the new tier). The `tierConfig` for a tier name comes from
   `getActiveTiers(activeCfg)[tier]` (already available as `tiersForCost` at
   `delegate.ts:173`).

3. **Per-attempt patch** (inside the loop, after `resolveTierModelGuard`
   succeeds at `delegate.ts:294-324`, before `session.prompt` at `delegate.ts:335`):
   - Resolve `cap` for the current tier (cache it on the `enterTier` call, or
     recompute — it is cheap).
   - If `ctx.opencodeConfig?.agent?.[tier]` exists and `cap` is `discrete` or
     `binary`: compute `patch = translateAtIndex(cap, state.levelIndex)`; if
     `patch != null`, snapshot the agent def baseline the FIRST time this tier
     is touched (store in a `Map<string, Record<string, unknown>>` declared
     before the loop), then `applyReasoningPatch(ctx.opencodeConfig.agent[tier], patch)`.
   - `none`/`budgeted`/missing-agent-def → skip patching (unchanged behavior).

4. **`bump` action handling**: after `nextAction` (`delegate.ts:465-470`), the
   existing `accept`/`give_up` branches stay; the trailing "retry or escalate"
   block (`delegate.ts:509-524`) must also handle `action.action === "bump"`:
   set `forcing`, call `advance(state, action)` (which increments
   `levelIndex`/`bumpsThisTier`), and emit a structured event. Add a
   `logEvent.routing.escalated`-style call (or reuse `logEscalation`) with
   `from = to = tier` and a distinct reason like `"reasoning-bump"` so operators
   see the bump path. Guard `ctx.opencodeConfig` for absence (it is optional —
   `context.ts:128`).

5. **Baseline restore**: in the per-attempt `finally` (`delegate.ts:525-532`)
   OR a new outer `finally` around the `while` loop, iterate the baseline
   snapshot `Map` and `restoreAgentBaseline(ctx.opencodeConfig.agent[tierName], baseline)`
   for each. This must be best-effort (try/catch + `log.warn`, matching the
   cleanup style at `delegate.ts:57-113`) so a restore failure never crashes a
   session.

6. **Reset on escalate**: after `advance` for an escalate, call `enterTier`
   again so `levelIndex`/`reasoningLadderLen` reflect the new tier before the
   next loop iteration patches it.

**Verify**: `pnpm typecheck` → exit 0; `pnpm test -- plugin-delegate` → all
existing delegate tests still pass (behavior unchanged when
`reasoningEscalation.enabled` is false/absent).

> **Crucial correctness check for this step** (add it as a STOP condition if
> uncertain): confirm that patching `ctx.opencodeConfig.agent[tier]` via
> `applyReasoningPatch` is observed by the subsequent `session.prompt({ body: {
> agent: tier } })`. Both reference the same live agent map populated by
> `registerTierAgents` (`agents.ts:112-156`), so the patch must flow through. If
> in the executor's environment the prompt does NOT pick up the patched variant,
> STOP and report — do not switch to passing variant via the prompt body without
> checking with the operator.

### Step 6: Update ladder test helpers + add bump tests

In `test/unit/ladder.test.ts`:

1. Extend `makePolicy` (`ladder.test.ts:33-42`) to default
   `reasoningEscalation: undefined` (feature off). Extend `makeState`
   (`ladder.test.ts:44-54`) to default `levelIndex: 0`, `bumpsThisTier: 0`,
   `reasoningLadderLen: 0`. This keeps every existing test's behavior unchanged
   and the property-based termination test (`ladder.test.ts:774-857`) valid.
2. Add a new `describe("reasoning bump")` block covering:
   - `canBumpReasoning` truth table (enabled/disabled × ladder/no-ladder ×
     rungs-remain/at-top × cap-not-hit/cap-hit).
   - `nextAction` returns `"bump"` when enabled + ladder + rungs remain + cap
     not hit.
   - `nextAction` returns `"escalate"` when enabled + ladder but at top rung
     (empty suffix) — no bump.
   - `nextAction` returns `"escalate"` when enabled + ladder but
     `bumpsThisTier >= maxLevelBumpsPerTier`.
   - `nextAction` returns `"retry"` (existing path) when feature off OR
     `reasoningLadderLen === 0`.
   - `advance({ action: "bump" })` increments `levelIndex` + `bumpsThisTier`
     only; `escalate` resets `levelIndex`/`bumpsThisTier`/`reasoningLadderLen`.
   - Bump respects `maxTotalAttempts` and cost ceiling (bumps never bypass the
     give_up guards).

**Verify**: `pnpm test -- ladder` → all pass, including the new cases and the
existing property-based test.

### Step 7: Add translate index-helper tests

In `test/unit/reasoning-translate.test.ts` (create if absent, modeling after
`test/unit/reasoning-capability.test.ts` / the existing translate tests):

- `resolveLevelIndex` for discrete (3-rung and 5-rung), binary, none, budgeted.
- `levelIndexForVariant`: discrete finds the index; unknown variant → `0`;
  binary elevated → `1`, else `0`.
- `translateAtIndex`: round-trips each index of a discrete ladder; binary
  index 0 → baseline (or null), index 1 → elevated; none/budgeted → null.
- `capabilityLadderLength`: discrete → `levels.length`; binary → `2`;
  none/budgeted → `0`.

**Verify**: `pnpm test -- reasoning-translate` → all pass.

### Step 8: Add a delegate bump-then-tier integration test

In `test/unit/plugin-delegate.test.ts` (or the closest existing delegate test
file — confirm the path with `rg -l "executeDelegate" test/`):

- A tier with `capability: { kind: "discrete", field: "reasoning.effort",
  levels: ["low","medium","high","xhigh","max"] }` and
  `reasoning.effort: "medium"`, with `reasoningEscalation: { enabled: true,
  maxLevelBumpsPerTier: 2 }`. Mock `session.prompt` to fail verification twice
  then pass. Assert the agent def's `options.reasoning_effort` progresses
  `medium → high → xhigh` across attempts (i.e. `applyReasoningPatch` was called
  with advancing indices), and that the baseline is restored after the loop.
- A `capability: { kind: "none" }` tier under the same enabled config: assert
  NO reasoning patch is applied and the existing `maxAttemptsPerTier` retry path
  is used (tier escalation unchanged).

If `executeDelegate` is hard to drive in-process (it depends on the SDK
client), model the test after the existing delegate tests' mocking approach —
read one existing test in the file first and mirror its setup. If the existing
delegate tests are purely unit-level on extracted helpers, test the
`enterTier` + patch-computation logic at that level instead and note the
end-to-end coverage gap in Maintenance notes.

**Verify**: `pnpm test -- plugin-delegate` → all pass.

### Step 9: Final verification

Run the full gate in order:

**Verify**:
- `pnpm typecheck` → exit 0
- `pnpm lint` → exit 0
- `pnpm test` → all pass (no regressions; new tests green)
- `pnpm build` → exit 0

## Test plan

New test cases (all listed in Steps 6–8). Structural patterns to follow:
- Ladder tests → `test/unit/ladder.test.ts` (`makePolicy`/`makeState` helpers,
  `describe`/`it` style, property-based termination block).
- Translate tests → existing reasoning test style (`test/unit/reasoning-capability.test.ts`).
- Delegate test → mirror whatever mocking the existing delegate tests use.

Verification: `pnpm test` → all pass, including the new bump/index cases.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0; new tests for `canBumpReasoning`, `nextAction` bump
      branch, `advance` bump/escalate reset, and the translate index helpers
      exist and pass
- [ ] With `reasoningEscalation` absent/false, `nextAction` is byte-for-byte
      equivalent to today for a `none`-capability tier (existing ladder tests
      unchanged and green)
- [ ] `pnpm build` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 034 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (the codebase has drifted since `7064e0d`).
- Patching `ctx.opencodeConfig.agent[tier]` via `applyReasoningPatch` is NOT
  observed by the subsequent `session.prompt({ body: { agent: tier } })` in the
  executor's environment (see the correctness check in Step 5). Do not switch
  mechanisms silently.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file (notably
  `tool-guards.ts`, `tiers.json`, or `policy.ts`).
- You find that `executeDelegate` is not actually reachable in the current
  default configuration (e.g. the delegate tool is fully experimental and
  unenabled) — report so the maintainer can decide whether to also enable the
  path.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **Starting level**: the bump starts from the tier's STATIC configured
  variant/effort (`tierConfig.variant` / `tier.reasoning.effort`). Wiring the
  reasoning POLICY resolver (`resolveReasoningOverride` in
  `src/reasoning/policy.ts`) into the delegate loop's first attempt — so the
  bump starts from the adaptive/manual/static policy level instead of the static
  variant — is a deliberately deferred follow-up. It is the natural next step
  and would make `reasoningPolicy.defaultLevel`/adaptive selection affect the
  delegate path the same way it affects the `task` path today.
- **Budgeted capability**: not supported for bumps in v1 (treated like `none`).
  If a budgeted tier (Anthropic-style token budgets) should bump through
  `minimal→normal→elevated→max` budgets, that is a separate enhancement: add a
  `resolveBudgetLevelIndex` path and a `budgetLadderLen` of 4.
- **What a reviewer should scrutinize**: (a) the `nextAction` ordering — that
  ladder tiers bump-then-escalate and never accidentally fall through to a
  same-level retry when the feature is on; (b) the baseline-restore in the
  delegate loop, so a bumped variant never leaks onto the shared agent def for
  subsequent dispatches; (c) that `none`-capability tiers are provably
  unchanged when the feature is off.
- **Future interaction**: if reasoning-escalation is ever added to the `task`
  tool path (`tool-guards.ts`), the `canBumpReasoning` helper and the translate
  index helpers added here are the shared building blocks — reuse them rather
  than duplicating.
