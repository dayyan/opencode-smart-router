# Plan 032: Align the Guard Resolver's `envGate` Access Path With the Typed Config

> **Executor instructions**: Follow this plan step by step. This plan touches the
> same files as Plan 031 (`tool-guards.ts`) plus the compiled ReScript resolver
> (`Guard.res`). Land 031 FIRST, then 032, on the same branch or merged
> sequentially to avoid conflicts.
>
> **Drift check**: `git diff --stat 25ee791..HEAD -- src/guard/Guard.res src/router/config.types.ts src/router/enforcement.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW–MED
- **Depends on**: Plan 031 (same-file sequencing; 031 fixed the `guardBeforeCall` env shape, 032 fixes the gate-name resolution that feeds it)
- **Category**: bugfix (config-contract restoration)
- **Planned at**: HEAD, 2026-08-08

## Why this matters

The plugin exposes a configurable gate variable:

```ts
// src/router/config.types.ts:59 — envGate is TOP-LEVEL
export interface EnforcementConfig {
  mode?: "off" | "advisory" | "enforced";
  envGate?: string;
  // ...
  guard?: { readDraftCap?: number; sameOpRetryCap?: number; /* ... */ };
}
```

A user who configures `enforcement.envGate: "MY_GATE"` is **type-correct**, but the value is **silently ignored**. The ReScript resolver reads the gate name from a *different* path than the typed config declares:

```rescript
// src/guard/Guard.res:926 — reads NESTED (enf.guard.envGate), always undefined
var gateName = (enf && enf.guard && enf.guard.envGate) || 'MODEL_ROUTER_ENFORCE';
```

Since `enforcement.guard.envGate` is never a real field (the type puts `envGate` at the top level), the resolver *always* falls back to the hard-coded default `"MODEL_ROUTER_ENFORCE"`. A custom gate is impossible to configure through the typed path.

### This is a regression, not a design choice

Before the ReScript migration (commit **`19d840d`**, `feat(router): add trajectory scorecard + enforcement-mode resolver`), there was a **single** TypeScript resolver. It read the gate name top-level from day one and still does today:

```ts
// src/router/enforcement.ts:32 — the ORIGINAL, correct, still-live implementation
const gateName = enf?.envGate ?? DEFAULT_ENV_GATE;
```

The ReScript port (commit **`25ee791`**, `feat(guard): port guard engine`) *duplicated* this resolver "to avoid cycle" (per the `Guard.res:916` comment) and **transcribed** `enf.envGate` as `enf.guard.envGate` — a transcription bug. The subsequent cutover (`55d1ee2`) deleted the guard `.ts` sources but **left `enforcement.ts` intact**, so two resolvers now coexist and disagree:

| Resolver | Location | Reads | Correct? |
|----------|----------|-------|----------|
| TS `resolveEnforcementMode` | `src/router/enforcement.ts:32` | `enf.envGate` (top-level) | ✅ matches type + pre-ReScript |
| ReScript `_resolveEnforcementMode` | `src/guard/Guard.res:926` | `enf.guard.envGate` (nested) | ❌ never matches; always defaults |

`tool-guards.ts` calls **both** on every `runSubagentGuard` invocation, so the two disagree in the same call stack. The goal of this plan: **restore the pre-ReScript contract** — one access path, top-level, matching the type.

## Current state

- **Typed config**: `src/router/config.types.ts:59` — `envGate` top-level. Unchanged since `18e813e`.
- **TS resolver**: `src/router/enforcement.ts:32` — reads `enf?.envGate ?? DEFAULT_ENV_GATE`. Unchanged since `19d840d`.
- **ReScript resolver (the bug)**: `src/guard/Guard.res:926` — reads `(enf && enf.guard && enf.guard.envGate) || 'MODEL_ROUTER_ENFORCE'`. Introduced at `25ee791`.
- **Reachable**: `guardBeforeCall` (`Guard.res:973`) internally calls `_resolveEnforcementMode`, so every guard check runs through the buggy path.
- **Plan-031 workaround**: `src/plugin/hooks/tool-guards.ts:337-339` deliberately reads the *nested* path (with a cast) to match the buggy resolver, with a comment flagging the mismatch as "out of scope." This plan makes that workaround obsolete.

## Commands

| Purpose     | Command                                              |
|-------------|------------------------------------------------------|
| Typecheck   | `pnpm run typecheck`                                 |
| Tests       | `pnpm test`                                          |
| Targeted    | `pnpm test -- tool-guards plugin-hooks`              |
| ReScript    | `pnpm run res:build` then `pnpm run test:res`        |
| Lint        | `pnpm run lint`                                      |
| Build       | `pnpm run build`                                     |

## Scope

**In scope**:

- `src/guard/Guard.res` — fix the `_resolveEnforcementMode` `%raw` block to read `enf.envGate` (top-level), matching the pre-ReScript resolver and the typed config.
- `src/plugin/hooks/tool-guards.ts` — flip the `gateName` extraction (lines 337-339) from the nested `cfg.enforcement.guard.envGate` path to the top-level `cfg.enforcement.envGate`, drop the cast, and remove the now-obsolete mismatch comment.
- `test/unit/plugin-hooks.test.ts` — add a test proving a custom gate configured via the **typed top-level** path (`enforcement.envGate`) is now honored (it was silently ignored before).

**Out of scope**:

- De-duplicating the two resolvers (one TS, one ReScript). That is a larger refactor tracked as a follow-up; this plan only aligns their access path.
- Restoring the `warning` field the ReScript port dropped (the TS resolver emits a warning for unrecognized env values at `enforcement.ts:46-48`; the ReScript port omits it). Noted as an optional step below; omit unless the diff stays trivial.
- Scoping the `resolveEnforcementMode` (TS) `process.env` pass at `tool-guards.ts:322`. That call site is one of several (`dispatch-io.ts:250`, `system-config.ts:53`, `builders.ts:66,73`); scoping only one would be inconsistent. Tracked as a separate follow-up.
- Any change to `src/router/config.types.ts` (the type is already correct).

## Steps

### Step 1: Fix the ReScript resolver access path

In `src/guard/Guard.res`, inside the `_resolveEnforcementMode` `%raw` block (~line 926), change the nested read to top-level:

**Before**:
```js
var gateName = (enf && enf.guard && enf.guard.envGate) || 'MODEL_ROUTER_ENFORCE';
```

**After**:
```js
var gateName = (enf && enf.envGate) || 'MODEL_ROUTER_ENFORCE';
```

This restores the exact pre-ReScript access path proven at commit `19d840d`. No other line in the `%raw` block changes.

**Verify**: `pnpm run res:build` compiles clean. `pnpm run test:res` — 473/473 pass.

### Step 2: Flip the `gateName` extraction in `tool-guards.ts`

Plan-031 deliberately read the nested path (with a cast) to match the buggy resolver. Now that the resolver is fixed, the extraction must read top-level too.

In `src/plugin/hooks/tool-guards.ts` (~lines 334-339):

**Before** (plan-031 workaround):
```ts
// Plan 031: pass only the configured gate key, not the full process.env.
// Cast follows the resolver's runtime path (enf.guard.envGate, Guard.res:926);
// the typed config has envGate top-level — a pre-existing mismatch (out of scope).
const gateName =
  (cfg?.enforcement?.guard as { envGate?: string } | undefined)?.envGate ??
  "MODEL_ROUTER_ENFORCE";
```

**After**:
```ts
// Pass only the configured gate key, not the full process.env (plan 031).
// envGate is top-level on EnforcementConfig (config.types.ts:59), matching the
// pre-ReScript resolver (enforcement.ts:32) and the Guard.res resolver (plan 032).
const gateName = cfg?.enforcement?.envGate ?? "MODEL_ROUTER_ENFORCE";
```

The cast disappears because `envGate` is a real typed field at the top level. The `guardEnv` construction below it is unchanged.

**Verify**: `pnpm run typecheck` — exit 0 (the cast removal should typecheck cleanly now that the path matches the type).

### Step 3: Add a custom-gate test via the typed path

Add a unit test in `test/unit/plugin-hooks.test.ts` that proves a custom gate configured through the **typed top-level** path is now honored end-to-end:

- Set `cfg.enforcement.envGate = "MY_GATE"` (top-level, type-correct — **no cast**).
- Set `process.env.MY_GATE = "1"`.
- Assert the `env` object passed to `guardBeforeCall` has exactly one key: `"MY_GATE"`.
- Assert the resolved mode is `"enforced"`.

This test would have **failed** before this plan (the gate name silently defaulted to `MODEL_ROUTER_ENFORCE`, so `MY_GATE` never appeared in the env object). It is the behavioral proof that the pre-ReScript contract is restored.

If plan-031 already added an ME-02 custom-gate test that set the field on the *nested* `guard` path with a cast, **update it** to use the top-level typed path and drop the cast — the nested path is no longer the source of truth.

**Verify**: `pnpm test -- plugin-hooks` — all pass, including the new/updated custom-gate test.

### Step 4: Run the full evidence path

```bash
pnpm run res:build
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:res
pnpm run build
```

Expected: all exit 0 (full `pnpm test` may show the pre-existing baseline drift documented in plan 029/031 — that is acceptable and NOT a regression from this change).

## Done criteria

- [ ] `Guard.res:926` reads `(enf && enf.envGate)` (top-level), not `(enf && enf.guard && enf.guard.envGate)` (nested).
- [ ] `tool-guards.ts` extracts `gateName` from `cfg?.enforcement?.envGate` (top-level) with **no cast**.
- [ ] The plan-031 mismatch comment is removed; the new comment references plan 031 (env shape) and plan 032 (access path).
- [ ] A test proves a custom gate set via the typed top-level path (`enforcement.envGate`) is honored — `MY_GATE` appears in the env object and resolves to the configured mode.
- [ ] No test that relied on the nested `guard.envGate` path remains (update or remove it).
- [ ] `pnpm run res:build`, `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `pnpm run test:res`, `pnpm run build` pass (baseline drift from plan 029/031 is acceptable).
- [ ] No files outside Scope are modified.

## STOP conditions

Stop and report instead of improvising if:

- `pnpm run res:build` fails after the `%raw` edit — the raw-JS syntax may have a subtle issue; report the compiler error rather than guessing at ReScript escape rules.
- A test that previously passed by relying on the nested `guard.envGate` path now fails in a way that is not fixed by flipping to top-level — there may be a second consumer of the nested path; report it rather than widening scope.
- The `warning` field restoration (optional, out of scope) turns out to require changing the ReScript return type — abort that optional step and keep the core fix.

## Maintenance notes

- **The typed config is the source of truth.** `envGate` lives at `enforcement.envGate` (top-level). Any future resolver — TS or ReScript — must read it there.
- **Two resolvers still exist** (TS `enforcement.ts` + ReScript `Guard.res`). This plan aligns their access path but does not de-duplicate them. A follow-up plan should collapse them to a single implementation (or generate one from the other) to prevent re-drift. The `Guard.res:916` comment ("duplicated from router/enforcement.ts to avoid cycle") names the original motivation for the split; revisit whether that cycle still exists before merging.
- **If a future change adds a second gated env feature**, the gate-name source stays `enforcement.envGate`. Do not reintroduce a nested `guard.envGate` path.
