# Plan 036: Cover escalation ladder boundary branches

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7cc892d..HEAD -- test/unit/ladder.test.ts src/escalate/ladder.ts vitest.config.ts package.json`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `7cc892d`, 2026-08-10

## Why this matters

`pnpm publish --dry-run` runs the `prepublishOnly` gate, which runs the full coverage suite. That suite currently fails because `src/escalate/**/*.ts` requires 95% branch coverage but `src/escalate/ladder.ts` reaches only 92.39%. The release is blocked despite all 2,246 tests passing. Add focused tests for the existing defensive and boundary behavior rather than weakening the release threshold introduced to protect publication quality.

## Current state

- `package.json:10-15` defines `prepublishOnly` as `pnpm run build && pnpm run test:gate`; `test:gate` runs `vitest run --coverage`.
- `vitest.config.ts:38-47` enforces `branches`, `lines`, and `functions` at 95% for `src/escalate/**/*.ts`.
- `src/escalate/ladder.ts:91-98` protects an array access with `return next ?? null`:

  ```ts
  export const nextTierAfter = (currentTier: string, policy: EscalatePolicy): string | null => {
    const ci = tierRank(currentTier, policy.ladder);
    if (ci >= 0 && ci + 1 <= policy.ladder.length - 1) {
      const next = policy.ladder[ci + 1];
      return next ?? null;
    }
    return null;
  };
  ```

- `src/escalate/ladder.ts:118-129` gates reasoning bumps using the configured cap or its default. `src/escalate/ladder.ts:170-198` returns `bump`, or promotes to the next tier when a rung or bump cap is exhausted.
- `src/escalate/ladder.ts:226-253` defensively leaves state unchanged when an `escalate` action has no `tier`.
- `test/unit/ladder.test.ts:34-58` provides `makePolicy` and `makeState`; existing tests in this file use `describe` / `it` / `expect` from Vitest and should be extended rather than creating a new file.
- The latest coverage run identifies uncovered branch paths at `src/escalate/ladder.ts:95,126,173,185,187,241`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `pnpm test -- test/unit/ladder.test.ts` | all ladder tests pass |
| Coverage gate | `pnpm run test:gate` | exit 0; no coverage threshold errors |
| Publish regression | `pnpm publish --dry-run` | exit 0; package dry-run completes |
| Typecheck | `pnpm run typecheck` | exit 0, no errors |
| Lint | `pnpm run lint` | exit 0, no diagnostics |

## Scope

**In scope** (the only files you should modify):
- `test/unit/ladder.test.ts`
- `plans/README.md` (mark this plan DONE after all verification gates pass)

**Out of scope** (do NOT touch):
- `src/escalate/ladder.ts` — implementation behavior is not changing.
- `vitest.config.ts` — do not lower or otherwise change coverage thresholds.
- `package.json` — do not bypass `prepublishOnly` or alter release scripts.

## Git workflow

- Branch: `advisor/036-cover-escalation-ladder-branches`
- Commit message style: conventional commits, for example `test: cover escalation ladder boundary branches`.
- Do NOT push or open a PR unless the operator instructs it.

## Steps

### Step 1: Add tests for the uncovered pure-function boundaries

Extend the existing `describe` blocks in `test/unit/ladder.test.ts`; preserve the `makePolicy` and `makeState` helper pattern. Add narrowly named tests that assert observable behavior, not coverage counters:

1. In the `nextTierAfter` tests, use a deliberately sparse `ladder` array with a valid next index whose value is `undefined`; assert the result is `null`.
2. In the `canBumpReasoning` tests, exercise an enabled policy with a non-empty reasoning ladder, a verification-failure verdict, and an omitted `maxLevelBumpsPerTier`; assert the default cap allows the bump. Also retain the explicit-cap behavior already covered by the suite.
3. In the `nextAction` reasoning-bump tests, assert the bump action when a rung and default bump allowance remain. Add a state with remaining reasoning rungs but an exhausted explicit bump cap and a higher tier available; assert `escalate` targets that next tier. This must reach the `bumpsLeft <= 0` arm without relying on the top-rung arm.
4. In the `advance` tests, pass `{ action: "escalate" }` without `tier`; assert that the returned state equals the original state.

Do not alter production code or the coverage configuration. Keep test fixtures local to this file unless an identical existing helper already expresses the state clearly.

**Verify**: `pnpm test -- test/unit/ladder.test.ts` → all ladder tests pass.

### Step 2: Prove the release gate is restored

Run the project coverage gate after the focused tests pass. Confirm the output does not contain a threshold failure for `src/escalate/**/*.ts`; the branch percentage must meet or exceed 95%.

**Verify**: `pnpm run test:gate` → exit 0 and no coverage threshold errors.

### Step 3: Verify the publication lifecycle end to end

Run the same dry-run command that originally failed. This invokes `prepublishOnly`, so it validates build plus the coverage gate under the actual publication lifecycle without publishing anything.

**Verify**: `pnpm publish --dry-run` → exit 0 and package dry-run completes.

## Test plan

- Extend `test/unit/ladder.test.ts`; follow its existing helper and describe-block structure.
- Cover sparse next-tier lookup returning `null`.
- Cover the omitted reasoning-bump cap default.
- Cover bump-to-next-tier promotion caused by an exhausted cap before the top rung.
- Cover a malformed `escalate` action without a tier returning its state unchanged.
- Verification: `pnpm test -- test/unit/ladder.test.ts`, then `pnpm run test:gate`, then `pnpm publish --dry-run` all exit 0.

## Done criteria

- [ ] `test/unit/ladder.test.ts` contains focused assertions for all four boundary behaviors above.
- [ ] `pnpm test -- test/unit/ladder.test.ts` exits 0.
- [ ] `pnpm run test:gate` exits 0 with no coverage threshold failure.
- [ ] `pnpm publish --dry-run` exits 0.
- [ ] `pnpm run typecheck` exits 0.
- [ ] `pnpm run lint` exits 0.
- [ ] No files outside the in-scope list are modified (`git status --short`).
- [ ] `plans/README.md` marks Plan 036 as DONE.

## STOP conditions

Stop and report back (do not improvise) if:

- The production behavior at `src/escalate/ladder.ts:91-98`, `118-129`, `170-198`, or `226-253` differs from the current-state description.
- A sparse array is rejected by the project typecheck or lint rules and no existing test convention represents this boundary safely.
- `pnpm run test:gate` still reports the escalation branch threshold after adding the named scenarios.
- Satisfying coverage requires changing `src/escalate/ladder.ts`, `vitest.config.ts`, or `package.json`.

## Maintenance notes

- Keep the 95% escalation branch gate: this module decides whether a failed delegation retries, bumps reasoning, promotes tiers, or gives up.
- Reviewers should verify that each new test asserts a distinct public outcome and that no test mutates global configuration.
- If later refactors remove a defensive branch, delete or adapt its test with the implementation; do not lower the threshold to conceal the change.
