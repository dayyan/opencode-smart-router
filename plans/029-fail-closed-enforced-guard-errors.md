# Plan 029: Fail Closed on Enforced-Mode Guard Errors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. This plan touches the same file as Plan 031 (`tool-guards.ts`);
> land 029 first, then 031, on the same branch or merged sequentially.
>
> **Drift check**: `git diff --stat c809a0e..HEAD -- src/plugin/hooks/tool-guards.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none (land before 031 to avoid `tool-guards.ts` conflicts)
- **Category**: correctness / security
- **Planned at**: commit `c809a0e`, 2026-08-08

## Why this matters

`src/plugin/hooks/tool-guards.ts:311-328` wraps the `guardBeforeCall`
invocation in a bare `catch { return }`. When the effective enforcement mode is
`enforced`, a guard-internal error (config parse failure, store throw, ReScript
ABI throw) silently **allows** the tool call to proceed — the exact opposite of
the enforcement contract. An enforced session should never let a tool call
through because the guard itself crashed.

In `advisory` / `off` mode, fail-soft is intentional and MUST stay unchanged:
the guard is advisory, so a guard-internal error must not break a real session.
The fix only changes control flow for `enforced` mode.

A secondary concern (CORR-01): even in fail-soft modes, the empty catch swallows
the error with no diagnostics. This plan also adds a structured `log.warn` on
every branch so operators can see when the guard failed internally.

## Current state

```ts
// src/plugin/hooks/tool-guards.ts:311-337
let res: BeforeResult;
try {
  const cfg = await ctx.getConfig();
  res = guardBeforeCall({
    cfg,
    tier: ctx.sessionStore.getTier(sid),
    trivial: ctx.sessionStore.isTrivial(sid),
    sessionID: sid,
    tool,
    toolArgs: (output?.args as Record<string, unknown> | undefined) ?? null,
    store: ctx.guardStore,
    env: Object.fromEntries(
      Object.entries(process.env).map(([k, v]) => [k, v ?? null]),
    ) as Record<string, string | null>,
  });
} catch {
  return; // never break a real session on a guard-internal error
}
if (res.block) {
  ctx.trajectoryStore.recordToolEvent(sid, { ... });
  throw new Error(res.message ?? "");
}
```

`resolveEnforcementMode` already exists at `src/router/enforcement.ts` and is
already imported in `src/plugin/hooks/system-config.ts:53` with this call shape:

```ts
resolveEnforcementMode({ config: cfg, env: process.env }).mode // "off"|"advisory"|"enforced"
```

## Commands

| Purpose     | Command                                              |
|-------------|------------------------------------------------------|
| Typecheck   | `pnpm run typecheck`                                 |
| Tests       | `pnpm test`                                          |
| Targeted    | `pnpm test -- tool-guards plugin-hooks`              |
| Lint        | `pnpm run lint`                                      |
| Build       | `pnpm run build`                                     |

## Scope

**In scope**:

- `src/plugin/hooks/tool-guards.ts` (`runSubagentGuard`)
- `test/unit/tool-guards.test.ts` (or the nearest existing hook test file)

**Out of scope**:

- `src/guard/Guard.res` — NO ReScript change; the guard logic is unchanged.
- `src/plugin/hooks/tool-execute.ts` after-hook (`guardAfterCall`) — same
  fail-soft pattern exists there; a follow-up plan should apply the same rule.
- `advisory` / `off` control flow — must remain fail-soft.
- The nested-`task` hard-throw at `tool-guards.ts:305` — unrelated, leave it.
- Plan 031's env-restriction change in the same file — separate plan.

## Steps

### Step 1: Resolve enforcement mode before the try/catch

The mode must be known so the catch block can decide fail-closed vs fail-soft.
Resolve it from the same cfg the guard will use, before invoking
`guardBeforeCall`. Use the existing `resolveEnforcementMode` helper imported
from `src/router/enforcement`.

```ts
const cfg = await ctx.getConfig();
let mode: "off" | "advisory" | "enforced" = "advisory";
try {
  mode = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
} catch (err) {
  // If mode itself cannot be resolved, default to advisory (fail-soft) but
  // still surface the failure. We deliberately do NOT assume enforced here.
  log.warn({ event: "guard.mode_resolve_failed", session: sid, tool, error: err instanceof Error ? err.message : String(err) });
}
```

### Step 2: Restructure the catch for enforced fail-closed

Move the `guardBeforeCall` call into a try, and on catch branch on `mode`:

- `mode === "enforced"` → fail closed: emit
  `log.warn({ event:"guard.enforce_failed_closed", session:sid, tool, error })`
  and `throw new Error("enforcement unavailable: guard evaluation failed; failing closed")`.
- `mode === "advisory"` or `"off"` → keep `return` (fail-soft) but ALSO emit
  `log.warn({ event:"guard.advisory_failed_soft", session:sid, tool, mode, error })`
  so the failure is no longer invisible.

`log` is already imported at the top of the file
(`import { log } from "../../utils/observability"`).

### Step 3: Add tests

Add unit tests (follow the existing pattern in `test/unit/plugin-hooks.test.ts`
or `test/unit/tool-guards.test.ts`) covering:

1. **Enforced + guard throws → call is blocked.** Mock `guardBeforeCall` /
   the cfg read to throw; assert the handler throws (or the tool call is
   rejected) when mode resolves to `enforced`.
2. **Advisory + guard throws → call allowed, warning logged.** Assert the
   handler returns without throwing AND that a `log.warn` with the
   `guard.advisory_failed_soft` event is emitted.
3. **Off + guard throws → call allowed, warning logged.**

If the existing test harness injects a fake `guardBeforeCall`, reuse that seam.
If not, inject via the cfg/store seam so the guard internals throw.

**Verify**: `pnpm test -- tool-guards plugin-hooks` — all pass.

### Step 4: Run the full evidence path

```bash
pnpm run typecheck
pnpm run lint
pnpm test
```

Expected: all exit 0. No behavior change for advisory/off beyond the new
warning log.

## Done criteria

- [ ] Enforced-mode guard-internal error throws (blocks the call).
- [ ] Advisory/off guard-internal error still returns (fail-soft).
- [ ] Both paths emit a structured `log.warn` event (no more silent catch).
- [ ] `resolveEnforcementMode` is used; no new mode-resolution logic duplicated.
- [ ] `pnpm run typecheck`, `pnpm run lint`, `pnpm test` pass.
- [ ] No files outside Scope are modified.

## STOP conditions

Stop and report instead of improvising if:

- `resolveEnforcementMode` cannot run outside `guardBeforeCall` without a cfg
  shape mismatch (the TS `RouterConfig` vs ReScript ABI) — add a thin adapter,
  do not `as`-cast blindly.
- The existing test harness has no seam to make `guardBeforeCall` throw —
  report so the test strategy can be adjusted, do not skip the tests.
- A test or build fails twice after a targeted correction.

## Maintenance notes

- `src/plugin/hooks/tool-execute.ts:143` (`guardAfterCall`) has the same bare
  `catch { }` pattern. A follow-up plan should apply the enforced-fail-closed
  rule there too; this plan intentionally scopes to the before-hook only.
- If a new enforcement mode is added, update both the catch branch and
  `resolveEnforcementMode`.
