# Plan 022: Add Light and Focused Routing Tiers

> ## ⚠️ REFRESHED 2026-08-08 (commit `c809a0e`) — PARTIALLY DONE / PARTIALLY OBSOLETE
>
> This plan was authored 2026-07-15 against commit `b1cfa25`, BEFORE the
> ReScript migration phases 4-5. Reconcile, don't duplicate — read this banner
> before using the body below.
>
> **What LANDED (DONE — do not redo):**
> - Step 4 (bundled config): all six presets in `config/tiers/presets.json`
>   now expose `fast / light / medium / focused / heavy`.
> - `src/router/TierLadder.res:19` now exports `resolveLadder` (the resolver
>   Step 1 wanted to create as `tier-ladder.ts`). It is fully tested in
>   `src/router/TierLadder_test.res` (asserts
>   `["fast","light","medium","focused","heavy"]`).
> - The ReScript escalation path (`src/escalate/Ladder.res`) already consumes
>   `TierLadder.resolveLadder`.
>
> **What is OBSOLETE:**
> - Step 1 (create `src/router/tier-ladder.ts`) — superseded by the existing
>   ReScript `TierLadder.resolveLadder`. Do NOT create a TS duplicate; wire
>   TS consumers to the ReScript resolver instead.
> - The file paths `src/router/protocol.ts` and `src/escalate/ladder.ts`
>   referenced in the body were migrated to `Protocol.res` / `Ladder.res`.
>
> **What REMAINS (the residue — this is the actual work now):**
> - `src/verify/checker.ts:61` still hard-codes
>   `const ladder = opts?.ladder ?? ["fast", "medium", "heavy"];`.
> - `src/router/sessions.ts:134` still hard-codes
>   `if (tier !== "fast") return false;` in `classifyTrivial` (this site was
>   NEVER covered by the original 022 — it is a newly identified gap).
>
> The narrowed execution steps are in **"## Residue execution plan"** at the
> END of this file. The original body below is retained as provenance.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If a provider model mapping is unavailable, stop and report it;
> do not invent an external model identifier.
>
> **Drift check**: `git diff --stat b1cfa25..HEAD -- src config scripts test docs tiers.json`
> Existing changes to `package.json` and `pnpm-lock.yaml` are unrelated to this
> plan and must not be reverted or modified.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: architecture
- **Planned at**: commit `b1cfa25`, 2026-07-15
- **Chained PRs recommended**: Yes; split foundation/config from protocol/tests/docs.

## Why this matters

The router currently exposes only `fast`, `medium`, and `heavy`, even though
most routing decisions fall between those broad capability and cost bands.
Adding `light` and `focused` enables localized implementation and deep
single-system work without immediately paying for the next highest tier.

The existing tier records are already generic, but escalation, verification,
protocol contracts, Claude prefixes, commands, and bundled configuration still
hard-code the three current names. This plan removes those assumptions while
preserving existing three-tier custom configurations.

## Target behavior

The default five-tier order is:

```text
fast -> light -> medium -> focused -> heavy
```

| Tier | Responsibility | Cost ratio | Default read cap |
|---|---|---:|---:|
| `fast` | Read-only exploration and lookup | 1 | 8 |
| `light` | Localized/simple implementation and small fixes | 2 | 7 |
| `medium` | Standard implementation, refactoring, and tests | 5 | 5 |
| `focused` | Deep single-system debugging or review | 10 | 4 |
| `heavy` | Architecture, security, performance, RCA, multi-system work | 20 | 3 |

Existing `fast`, `medium`, and `heavy` ratios remain unchanged.

Provider model IDs for `light` and `focused` are maintainer-supplied. The
executor may reuse an existing model from the same preset when appropriate, but
must not guess a provider/model identifier. Every new tier must still contain a
valid non-empty `model` field and pass existing config validation.

## Current state

- `src/router/config.types.ts:27-47` defines `TierConfig` and `Preset` as
  generic records, so new tier names are type-compatible.
- `src/escalate/ladder.ts:171-179` defaults to `fast, medium, heavy`.
- `src/verify/checker.ts:35-67` and `src/verify/dispatch.ts:308,451` duplicate
  the same three-tier fallback.
- `src/router/protocol.ts:112-146` contains static role contracts and routing
  text for the three current tiers; `CLAUDE_TIER_PREFIX` at lines 172-203 has
  the same three keys.
- `config/tiers/base.json:4-9` defines caps and the default tier.
- `config/tiers/presets.json` defines six provider presets, each with exactly
  `fast`, `medium`, and `heavy` today.
- `config/tiers/prompts.json` and `config/tiers/task-patterns.json` define
  tier-specific prompts, task patterns, modes, and routing rules.
- `buildDecomposeHint` in `src/router/protocol.ts:59-75` already sorts tiers by
  `costRatio`, so it should remain data-driven.
- `vitest.config.ts:8-9,27-43` defines coverage thresholds but does not fail on
  threshold violations; enabling coverage enforcement is out of scope here.

## Commands

| Purpose | Command | Expected result |
|---|---|---|
| Build bundled config | `npm run build` | exit 0; `tiers.json` is regenerated |
| Typecheck | `pnpm typecheck` | exit 0 with no TypeScript errors |
| Tests | `pnpm test` | all tests pass |
| Targeted tests | `pnpm test -- ladder checker protocol router-agents router-commands tiers-assembly` | all matching tests pass |
| Lint | `pnpm lint` | exit 0 |

## Scope

**In scope**:

- `src/router/tier-ladder.ts` (create)
- `src/router/config.types.ts`
- `src/escalate/ladder.ts`
- `src/verify/checker.ts`
- `src/verify/dispatch.ts`
- `src/router/protocol.ts`
- `src/router/commands.ts`
- `config/tiers/base.json`
- `config/tiers/presets.json`
- `config/tiers/prompts.json`
- `config/tiers/task-patterns.json`
- `test/unit/tier-ladder.test.ts` (create)
- `test/unit/ladder.test.ts`
- `test/unit/checker.test.ts`
- `test/unit/verify-dispatch.test.ts`
- `test/unit/protocol.test.ts`
- `test/unit/router-agents.test.ts`
- `test/unit/router-commands.test.ts`
- `test/unit/tiers-assembly.test.ts`
- golden snapshots under `test/golden/`
- `docs/ESCALATION.md`, `docs/ENFORCEMENT_PRESETS.md`,
  `docs/CONFIG_REFERENCE.md`, `docs/VERIFICATION.md`
- generated `tiers.json`

**Out of scope**:

- Changing existing `fast`, `medium`, or `heavy` semantics.
- Enabling coverage thresholds.
- Guard error handling or grader-temperature logging.
- Provider fallback order in `task-patterns.json`.
- Unrelated existing changes in `package.json` and `pnpm-lock.yaml`.
- Introducing new runtime dependencies.

## Steps

### Step 1: Add one canonical ladder resolver

Create `src/router/tier-ladder.ts` with a pure `resolveLadder(cfg)` helper.

Resolution order MUST be:

1. A non-empty `cfg.enforcement.escalate.ladder` supplied by the operator.
2. The active preset's tiers sorted ascending by `costRatio`, with stable
   insertion order as the tie-breaker.
3. `['fast', 'light', 'medium', 'focused', 'heavy']` filtered to names present
   in the active preset.

The resolver MUST return a new array and MUST NOT mutate the preset or config.
It MUST preserve a custom three-tier preset as a three-tier ladder when no
explicit ladder is configured.

**Verify**: Add unit tests for explicit order, five-tier cost order, custom
three-tier compatibility, missing cost ratios, duplicate ratios, and empty
explicit ladders. Run `pnpm test -- tier-ladder`.

### Step 2: Replace duplicated ladder fallbacks

Use `resolveLadder` in:

- `buildEscalatePolicy` in `src/escalate/ladder.ts`.
- `atLeastProducerTier` call paths in `src/verify/checker.ts`.
- `buildGateDeps` and `verifyTaskAfterHook` in `src/verify/dispatch.ts`.

Keep the public behavior of explicitly supplied `ladder` arrays unchanged.
Do not make `checker.ts` read global config implicitly; pass the resolved
ladder through its existing dependency boundary.

**Expected behavior**: escalation and grading use the same tier order for every
preset. No production module contains a second hard-coded three-tier fallback.

**Verify**: `pnpm test -- ladder checker verify-dispatch` passes.

### Step 3: Generalize verification skipping

Add `skipTiers?: string[]` to `EnforcementConfig.verify`.

Resolve verification skipping as follows:

- If `skipTiers` is provided, skip exactly the listed producer tiers.
- Otherwise, preserve `skipFastTier: true` as the backward-compatible default
  that skips only `fast`.
- Do not silently make existing `skipFastTier` configs skip `light`.

Update comments and verification tests to cover both fields and precedence.

**Verify**: `pnpm test -- verify-dispatch config-validate` passes.

### Step 4: Add the two tiers to bundled configuration

Update all six preset entries in `config/tiers/presets.json` with `light` and
`focused`. Use cost ratios 2 and 10. The maintainer must provide valid model
IDs; stop if a mapping is missing. Keep provider-specific `variant`, thinking,
reasoning, capability, steps, description, and `whenToUse` internally
consistent.

Update:

- `config/tiers/base.json`: caps `light: 7`, `focused: 4`; keep
  `defaultTier: "medium"`.
- `config/tiers/prompts.json`: scoped prompts for simple edits and focused
  single-system analysis.
- `config/tiers/task-patterns.json`: patterns for both new tiers; update the
  routing rules and CAP documentation; keep `normal=medium`, `budget=fast`,
  and `deep=heavy`; set `quality=focused` only if the preset's focused model
  mapping is supplied and validated.

**Expected behavior**: every bundled preset exposes five tiers, while existing
custom configs remain valid without adding the new names.

**Verify**: `npm run build` followed by
`pnpm test -- tiers-assembly config-validate` passes.

### Step 5: Extend protocol and command surfaces

Update `src/router/protocol.ts`:

- Add `light` and `focused` routing rules and role contracts.
- Define `light` as edit-capable but localized and scope-limited.
- Define `focused` as deep single-system work that escalates to `heavy` when
  architecture, security, performance, or multi-system tradeoffs are involved.
- Add Claude prefixes for both keys in `CLAUDE_TIER_PREFIX`.
- Keep the dynamic tier summary and cost display data-driven.

Update `src/router/commands.ts` so `/tiers` and `/annotate-plan` list all
active tiers rather than only three hard-coded names.

**Expected behavior**: generated delegation prompts accurately describe all
active tiers; Claude-backed `light` and `focused` agents receive the same scope
protection as existing Claude tiers.

**Verify**: `pnpm test -- protocol router-agents router-commands` passes.

### Step 6: Add five-tier and compatibility tests

Update unit tests to cover:

- Escalation through all five positions.
- Grader selection at every producer tier.
- Explicit custom ladder precedence.
- Three-tier custom preset compatibility.
- Five-tier agent registration and Claude prefixes.
- Five-tier command output and annotation guidance.
- Every bundled preset containing all five tier names.

Regenerate only the golden baselines consumed by
`test/golden/protocol.golden.test.ts` and
`test/golden/assembled-prompt.golden.test.ts` after behavior tests pass.

**Verify**: `pnpm test` passes; no snapshot update may be used to hide a
functional assertion failure.

### Step 7: Update documentation

Document the five-tier order, responsibilities, ratios, explicit ladder
override, custom three-tier compatibility, and `skipTiers` in:

- `docs/ESCALATION.md`
- `docs/ENFORCEMENT_PRESETS.md`
- `docs/CONFIG_REFERENCE.md`
- `docs/VERIFICATION.md`

Provider model mappings MUST be documented as configurable per preset; do not
claim that every provider supplies five distinct model families.

**Verify**: search the documentation and source for stale default references to
`["fast", "medium", "heavy"]`; only historical examples or explicit backward
compatibility references may remain.

### Step 8: Run the full evidence path

Run, in order:

```bash
npm run build
pnpm typecheck
pnpm lint
pnpm test
git diff --check
```

Expected result: all commands exit 0, generated `tiers.json` matches the
source fragments, all bundled presets expose the five-tier behavior, and no
files outside Scope are modified.

## Done criteria

- [ ] `resolveLadder` is the only fallback ladder implementation.
- [ ] Explicit custom ladders retain priority.
- [ ] Custom three-tier configs still work without `light` or `focused`.
- [ ] All bundled presets contain valid `light` and `focused` definitions.
- [ ] Existing tier ratios remain `fast=1`, `medium=5`, `heavy=20`.
- [ ] `skipTiers` works and `skipFastTier` remains backward-compatible.
- [ ] Protocol, commands, Claude prefixes, tests, snapshots, and docs describe the new tiers.
- [ ] `npm run build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `git diff --check` pass.
- [ ] No unrelated files are modified.

## STOP conditions

Stop and report instead of improvising if:

- A provider model ID for `light` or `focused` has not been supplied or fails
  existing model/config validation.
- A custom three-tier configuration requires adding new tier definitions to
  remain valid.
- Resolving the ladder from `costRatio` changes an explicitly configured ladder.
- The generated protocol requires provider-specific behavior not represented by
  the existing `TierConfig` fields.
- A test or build fails twice after a targeted correction.
- The implementation requires changing files outside Scope.

## Maintenance notes

- Future tier additions should update preset data and tests, not add new
  hard-coded ladder arrays.
- Keep `skipTiers` name-based and validate unknown names consistently with the
  existing config validation policy.
- Review cost-ceiling documentation whenever a tier ratio changes.
- The provider mapping is intentionally data-driven; model availability and
  pricing must be reviewed separately from router mechanics.

---

## Residue execution plan (2026-08-08 refresh, commit `c809a0e`)

Only the two TS hard-code sites below remain. The ReScript resolver already
exists; wire TS to it.

### Residue-Step 1: Wire `checker.ts` to the existing `TierLadder.resolveLadder`

`src/verify/checker.ts:61`:
```ts
const ladder = opts?.ladder ?? ["fast", "medium", "heavy"];
```

- `runChecker` receives `deps.ladder` (`CheckerDeps`). Make the caller
  (`src/verify/dispatch.ts`, in `buildGateDeps` / `verifyTaskAfterHook`)
  always pass `TierLadder.resolveLadder(cfg)` into `CheckerDeps.ladder`.
- Keep `opts?.ladder` override precedence for explicit operator ladders.
- Fix the stale comment at `checker.ts:37` (`// default ["fast","medium","heavy"]`).
- Confirm `src/types/rescript-modules.d.ts` declares the `*TierLadder.res.mjs`
  module with `resolveLadder(cfg): string[]` so the TS import type-checks; add
  the declaration if missing.

**Verify**: `pnpm test -- checker verify-dispatch`; `pnpm run typecheck`.

### Residue-Step 2: Generalize `classifyTrivial` in `sessions.ts`

`src/router/sessions.ts:134`:
```ts
if (tier !== "fast") return false;
```

This hard-codes `fast` as the only trivial-eligible tier — wrong for five-tier
presets where `light` (costRatio 2) should also qualify. This site was never
in the original plan.

- Replace the name check with a derived eligibility rule. Preferred: a
  costRatio ceiling (tiers whose `costRatio` is at or below a threshold —
  defaulting to `light`'s ratio — are trivial-eligible), read from the active
  preset. This keeps it data-driven and tier-name-agnostic.
- Preserve the existing guard: a dispatch matching `medium`/`heavy`
  disqualifier keywords is NEVER trivial.
- Add focused tests: `light` can be classified trivial when fast-patterns
  match; `medium`/`focused`/`heavy` never are; a custom three-tier preset
  with only `fast`/`medium`/`heavy` still behaves exactly as before.

**Verify**: `pnpm test -- sessions`; `pnpm run typecheck`.

### Residue-Step 3: Run the full evidence path

```bash
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:res
```

### Residue done criteria

- [ ] `rg -n '"fast", "medium", "heavy"' src/` returns zero production hits.
- [ ] `rg -n 'tier !== "fast"' src/` returns zero production hits.
- [ ] All five tiers grade / escalate / trivial-classify correctly.
- [ ] A custom three-tier preset still works without `light`/`focused`.
- [ ] `TierLadder.resolveLadder` is the single source of ladder order.

### Residue STOP conditions

- If `TierLadder.resolveLadder`'s `Config.t` (ReScript ABI) shape does not
  match the TS `RouterConfig` at the call boundary, add a thin adapter; do
  not `as`-cast blindly.
- If changing trivial-eligibility from a name to a costRatio rule breaks an
  existing golden/integration test, investigate the assertion before changing
  it — do not relax a security-relevant check to make a test pass.
