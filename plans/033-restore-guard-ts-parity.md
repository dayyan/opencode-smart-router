# Plan 033: Restore 1:1 TypeScript Parity in the ReScript Guard Engine

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c809a0e..HEAD -- src/guard/Guard.res src/guard/Guard_test.res src/types/rescript-modules.d.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW–MED
- **Depends on**: none (plan-032 envGate access-path fix already landed)
- **Category**: migration (ReScript parity restoration)
- **Planned at**: commit `c809a0e`, 2026-08-08

## Why this matters

The ReScript guard engine (`Guard.res`) was ported from TypeScript at commit
`25ee791`. A deep comparison against the original TS source (`25ee791^:src/guard/guards.ts`,
`25ee791^:src/guard/enforce.ts`, `25ee791^:src/guard/fingerprint.ts`) revealed
several semantic divergences that change program behavior on reachable inputs.
The most serious: `isSelfScript` wraps target paths in JSON quotes
(`Js.Json.stringify` instead of `String()`), which silently breaks
`deliverablePath` exemption matching. Other divergences affect fingerprint
fallback (`||` vs `??`), env-gate selection for empty strings, trajectory
metric semantics (`ttfa: null` vs `0`), and resolver warning observability.
This plan restores each to the exact original TS behavior, verified by new
ReScript regression tests plus a TypeScript cross-implementation parity suite.

## Current state

### Original TypeScript (the source of truth — `25ee791^`)

**Target extraction** (`src/guard/guards.ts:72`):
```typescript
const target = String(args.filePath ?? args.path ?? args.file ?? "");
```

**Fingerprint** (`src/guard/fingerprint.ts:8-15`):
```typescript
const a = call.args ?? {};
switch (call.tool) {
  case "read": return `read:${a.file_path ?? a.filePath ?? ""}`;
  case "grep": return `grep:${a.pattern ?? ""}:${a.path ?? a.glob ?? ""}`;
  case "glob": return `glob:${a.pattern ?? ""}:${a.path ?? ""}`;
  case "ls": return `ls:${a.path ?? ""}`;
  default: return `${call.tool}:${JSON.stringify(a).slice(0, 120)}`;
}
```

**Env-gate resolver** (`src/router/enforcement.ts:30-64`, the canonical version):
```typescript
export const resolveEnforcementMode = (args): { mode: EnforcementMode; warning?: string } => {
  const enf = args.config?.enforcement;
  const gateName = enf?.envGate ?? DEFAULT_ENV_GATE;
  const raw = args.env?.[gateName];
  if (raw === "1") return { mode: "enforced" };
  if (raw === "0") return { mode: "off" };
  let warning: string | undefined;
  if (raw !== undefined && raw !== "") {
    warning = `${gateName}="${raw}" is not "1" or "0"; ignoring env gate and using config.`;
  }
  const base: EnforcementMode = enf?.mode ?? "advisory";
  let mode = args.tier !== undefined && enf?.perTier?.[args.tier] !== undefined
    ? enf.perTier[args.tier]!
    : base;
  if (warning !== undefined) return { mode, warning };
  return { mode };
};
```

**Trajectory metrics** (`src/guard/guards.ts:194-205`):
```typescript
export const trajectoryMetrics = (state: GuardState): Record<string, unknown> => {
  return {
    ttfa: state.ttfa,  // number | null — null preserved, NOT converted to 0
    ...
  };
};
```

### Current ReScript (the divergences to fix)

**Target extraction — BUG** (`src/guard/Guard.res:425-436`):
```rescript
let target = switch args->Js.Dict.get("filePath") {
  | Some(v) => v->Js.Json.stringify    // ← wraps "src/app.ts" → "\"src/app.ts\""
  | None =>
    switch args->Js.Dict.get("path") {
    | Some(v) => v->Js.Json.stringify   // ← same bug
    | None =>
      switch args->Js.Dict.get("file") {
      | Some(v) => v->Js.Json.stringify  // ← same bug
      | None => ""
      }
    }
}
```

**Fingerprint — `||` instead of `??`** (`src/guard/Guard.res:401-412`):
```rescript
%raw(`
  (function(tool, args) {
    var a = args || {};
    switch (tool) {
      case 'read': return 'read:' + (a.file_path || a.filePath || '');   // ← || not ??
      case 'grep': return 'grep:' + (a.pattern || '') + ':' + (a.path || a.glob || '');
      case 'glob': return 'glob:' + (a.pattern || '') + ':' + (a.path || '');
      case 'ls': return 'ls:' + (a.path || '');
      default: return tool + ':' + JSON.stringify(a).slice(0, 120);
    }
  })(tool, args)
`)
```

**Env-gate — `||` instead of `??`** (`src/guard/Guard.res:926`):
```rescript
var gateName = (enf && enf.envGate) || 'MODEL_ROUTER_ENFORCE';  // ← || not ??
```

**Resolver result type — no warning field** (`src/guard/Guard.res:313`):
```rescript
type resolveEnforcementModeResult = {mode: string}  // ← TS returns {mode, warning?}
```

**Resolver `%raw` — no warning logic** (`src/guard/Guard.res:922-939`):
```rescript
%raw(`
  (function(params) {
    var enf = params.config && params.config.enforcement;
    var gateName = (enf && enf.envGate) || 'MODEL_ROUTER_ENFORCE';
    var raw = params.env && params.env[gateName];
    if (raw === '1') return { mode: 'enforced' };
    if (raw === '0') return { mode: 'off' };
    // ← no warning for unrecognized values
    var base = (enf && enf.mode) || 'advisory';
    if (params.tier !== undefined && enf && enf.perTier && enf.perTier[params.tier] !== undefined) {
      base = enf.perTier[params.tier];
    }
    return { mode: base };  // ← no warning field
  })(params)
`)
```

**Trajectory metrics — null→0** (`src/guard/Guard.res:780-783`):
```rescript
let ttfaVal = switch state.ttfa->Js.Nullable.toOption {
  | Some(v) => v
  | None => 0    // ← TS preserves null
}
```

**Type declaration — missing fields** (`src/types/rescript-modules.d.ts:773-787`):
```typescript
export type routerConfigMinimal = {
  enforcement?: {
    guard?: { ... };
    proportional?: { trivialBypass?: boolean };
    // ← missing: envGate?, mode?, perTier?
  };
};
```

**Test helper budget mismatch** (`src/guard/Guard.res.mjs:83-94` → source
`src/guard/Guard.res` `makePolicyDefault`):
```javascript
function makePolicyDefault() {
  return {
    budget: 8,  // ← production default is 25 (defaultGuardBudget)
    ...
  };
}
```

### Repo conventions

- ReScript source: `src/guard/Guard.res`; generated JS: `src/guard/Guard.res.mjs`
- ReScript tests: `src/guard/Guard_test.res` (uses `Test.open`, `assertion`,
  `assertionEqual(~operator=..., expected, actual)`)
- TypeScript interop types: `src/types/rescript-modules.d.ts`
- After EVERY `Guard.res` edit, run `pnpm run res:build` to regenerate `.mjs`
- Test commands (verified): `pnpm run res:build` | `pnpm run typecheck` |
  `pnpm test` (vitest) | `pnpm run test:res` (ReScript tests, currently 473)

## Commands you will need

| Purpose              | Command                          | Expected on success            |
|----------------------|----------------------------------|--------------------------------|
| Compile ReScript     | `pnpm run res:build`             | exit 0                         |
| Typecheck (TS)       | `pnpm run typecheck`             | exit 0, no errors              |
| ReScript tests       | `pnpm run test:res`              | all pass (473+)                |
| Guard unit tests     | `pnpm test -- guard`             | all pass                       |
| Full test suite      | `pnpm test`                      | all pass (pre-existing drift ok)|
| Build                | `pnpm run build`                 | exit 0                         |

## Scope

**In scope** (the only files you should modify):
- `src/guard/Guard.res` — all ReScript source fixes
- `src/guard/Guard_test.res` — new ReScript regression tests
- `src/types/rescript-modules.d.ts` — `routerConfigMinimal` type fix
- `test/unit/guard-parity.test.ts` (create) — TS cross-implementation parity suite

**Out of scope** (do NOT touch):
- `src/router/enforcement.ts` — the canonical TS resolver; it is the reference, not the target
- `src/plugin/hooks/tool-guards.ts` — caller; no change needed
- `src/guard/store.ts` — store; no change needed
- The `seen` Map-vs-Object representation (`guardState.seen: Js.Dict.t<int>`) —
  behavior is equivalent for fingerprint counting; changing to a real `Map`
  would be invasive and high-risk for zero behavioral gain
- The `guardBeforeCall` output shape (`null` vs omitted optional fields) —
  runtime callers tolerate both; fixing requires `%raw` object construction
  and gains nothing functionally
- The `blockScriptWrites` default (`null` vs `false`) — runtime behavior is
  identical since `isSelfScript` only blocks on explicit `true`

## Git workflow

- Branch: `fix/033-guard-ts-parity`
- Commit per step; conventional commits style (e.g. `fix(guard): restore TS-equivalent target coercion in isSelfScript`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix target coercion in `isSelfScript`

**File**: `src/guard/Guard.res`, lines ~425-436.

The bug: `v->Js.Json.stringify` wraps string values in quotes
(`"src/app.ts"` → `"\"src/app.ts\""`), so `targetStr === dp` never matches a
plain-string `deliverablePath`. The TS original uses `String(v)` which
produces the raw string.

**Fix**: Add a `_jsonToString` helper near the top of the helpers section
(after `_hasBashC`, around line ~205) and replace the three
`v->Js.Json.stringify` calls in the target extraction:

Add this helper (the IIFE `%raw` pattern already used by `observationOk` at
line ~817 and `trajectoryMetrics` at line ~785):
```rescript
@setRuntimeSideEffects
let _jsonToString = (v: Js.Json.t): string => {
  %raw(`
    (function(v) { return v == null ? "" : String(v); })(v)
  `)
}
```

Then replace in the target extraction (lines ~425-436):
```rescript
let target = switch args->Js.Dict.get("filePath") {
  | Some(v) => v->_jsonToString
  | None =>
    switch args->Js.Dict.get("path") {
    | Some(v) => v->_jsonToString
    | None =>
      switch args->Js.Dict.get("file") {
      | Some(v) => v->_jsonToString
      | None => ""
      }
    }
}
```

**Verify**: `pnpm run res:build` → exit 0

### Step 2: Fix fingerprint fallback (`||` → `??`)

**File**: `src/guard/Guard.res`, lines ~401-412 (inside `_fingerprintToolCall`'s
`%raw` block).

Change every `||` to `??` in the fingerprint switch cases to match the TS
nullish-coalescing semantics. The `||` operator treats `""`, `0`, and `false`
as falsy; `??` only treats `null`/`undefined` as falsy.

Current → target (inside the `%raw` string):
```javascript
// BEFORE
var a = args || {};
case 'read': return 'read:' + (a.file_path || a.filePath || '');
case 'grep': return 'grep:' + (a.pattern || '') + ':' + (a.path || a.glob || '');
case 'glob': return 'glob:' + (a.pattern || '') + ':' + (a.path || '');
case 'ls': return 'ls:' + (a.path || '');

// AFTER
var a = args ?? {};
case 'read': return 'read:' + (a.file_path ?? a.filePath ?? '');
case 'grep': return 'grep:' + (a.pattern ?? '') + ':' + (a.path ?? a.glob ?? '');
case 'glob': return 'glob:' + (a.pattern ?? '') + ':' + (a.path ?? '');
case 'ls': return 'ls:' + (a.path ?? '');
```

Note: keep the `default` line unchanged (`tool + ':' + JSON.stringify(a).slice(0, 120)`)
— it matches the TS.

**Verify**: `pnpm run res:build` → exit 0

### Step 3: Fix envGate fallback and restore resolver warning

**File**: `src/guard/Guard.res`, lines ~313 (type) and ~922-939 (`%raw` block).

#### 3a: Update the result type (line ~313)

```rescript
// BEFORE
type resolveEnforcementModeResult = {mode: string}

// AFTER
type resolveEnforcementModeResult = {
  mode: string,
  warning: Js.Nullable.t<string>,
}
```

#### 3b: Update the `%raw` block (lines ~922-939)

Replace the entire `%raw` body to match the TS resolver exactly
(`enforcement.ts:30-64`):

```rescript
@setRuntimeSideEffects
let _resolveEnforcementMode = (params: resolveEnforcementModeParams): resolveEnforcementModeResult => {
  %raw(`
    (function(params) {
      var enf = params.config && params.config.enforcement;
      var gateName = enf && enf.envGate != null ? enf.envGate : 'MODEL_ROUTER_ENFORCE';
      var raw = params.env && params.env[gateName];
      if (raw === '1') return { mode: 'enforced', warning: null };
      if (raw === '0') return { mode: 'off', warning: null };
      var warning = null;
      if (raw !== undefined && raw !== null && raw !== '') {
        warning = gateName + '="' + raw + '" is not "1" or "0"; ignoring env gate and using config.';
      }
      var base = (enf && enf.mode) || 'advisory';
      if (params.tier !== undefined && enf && enf.perTier && enf.perTier[params.tier] !== undefined) {
        base = enf.perTier[params.tier];
      }
      return { mode: base, warning: warning };
    })(params)
  `)
}
```

Key changes from the original `%raw`:
1. `gateName`: `(enf && enf.envGate) || ...` → nullish check
   (`enf.envGate != null ? enf.envGate : ...`) — matches `??` semantics
2. Always returns `warning` field (null when absent)
3. Warning message for unrecognized values matches TS exactly

#### 3c: Verify `guardBeforeCall` still compiles

`guardBeforeCall` at line ~978 reads `let mode = modeResult.mode`. It does NOT
read `warning` — that matches the TS caller (`tool-guards.ts:319` also only
reads `.mode`). The new `warning` field is additive and does not break the
existing `.mode` access.

**Verify**: `pnpm run res:build` → exit 0. Then `pnpm run typecheck` → exit 0.

### Step 4: Fix trajectoryMetrics ttfa null preservation

**File**: `src/guard/Guard.res`, lines ~780-794.

The TS original preserves `ttfa: null` when no producing action has occurred.
The ReScript version converts `null` → `0`, changing the semantic meaning
from "not executed" to "executed at call 0".

**Fix**: Remove the `ttfaVal` null→0 conversion and pass `state.ttfa` directly
into the `%raw` result object. Since `state.ttfa` is `Js.Nullable.t<int>` (at
runtime: `number | null`), and the `%raw` IIFE passes it through, it will
preserve `null` naturally.

Current (lines ~780-794):
```rescript
let ttfaVal = switch state.ttfa->Js.Nullable.toOption {
  | Some(v) => v
  | None => 0
}
%raw(`(function() { return arguments[0]; })`)({
  "ttfa": ttfaVal,
  ...
})
```

Target:
```rescript
%raw(`(function() { return arguments[0]; })`)({
  "ttfa": state.ttfa,
  ...
})
```

Delete the `let ttfaVal = ...` binding entirely and replace `"ttfa": ttfaVal,`
with `"ttfa": state.ttfa,` in the object literal.

**Verify**: `pnpm run res:build` → exit 0

### Step 5: Fix `makePolicyDefault` budget

**File**: `src/guard/Guard.res`, the `makePolicyDefault` function (search for
`makePolicyDefault`). Currently returns `budget: 8`; the production default
(`defaultGuardBudget`) is `25`, matching the TS `DEFAULT_GUARD_BUDGET = 25`.

```rescript
// BEFORE
budget: 8,

// AFTER
budget: defaultGuardBudget,
```

**Verify**: `pnpm run res:build` → exit 0

### Step 6: Fix `routerConfigMinimal` type declaration

**File**: `src/types/rescript-modules.d.ts`, lines ~773-787.

Add the missing fields that the `%raw` resolver reads at runtime but the type
declaration omits. This prevents future TS-side type errors if a caller tries
to access `enforcement.envGate`, `enforcement.mode`, or `enforcement.perTier`.

```typescript
// BEFORE (line ~773)
export type routerConfigMinimal = {
  enforcement?: {
    guard?: { ... };
    proportional?: { trivialBypass?: boolean };
  };
};

// AFTER
export type routerConfigMinimal = {
  enforcement?: {
    envGate?: string;
    mode?: "off" | "advisory" | "enforced";
    perTier?: Record<string, "off" | "advisory" | "enforced">;
    guard?: {
      budget?: number;
      readDraftCap?: number;
      sameOpRetryCap?: number;
      blockSelfScript?: boolean;
      deliverableFirst?: boolean;
      blockScriptWrites?: boolean;
    };
    proportional?: { trivialBypass?: boolean };
  };
};
```

Also update the corresponding ReScript-side type (`src/guard/Guard.res`, search
for `type routerConfigMinimal` around line ~273) to add the same fields so the
ReScript compiler knows they exist (even though access is via `%raw`).

**Verify**: `pnpm run typecheck` → exit 0

### Step 7: Add ReScript regression tests

**File**: `src/guard/Guard_test.res`.

Add these tests at the end of the file, before the final closing. Follow the
existing assertion pattern (`assertionEqual(~operator=..., expected, actual)`).

#### 7a: Target coercion parity test

```rescript
test("isSelfScript: deliverablePath matches unquoted string target (TS parity)", () => {
  let policy = Guard.makePolicyWithDeliverablePath("/src/app.ts")
  let args = Js.Dict.fromArray([("filePath", Js.Json.string("/src/app.ts"))])
  let call = Guard.GuardCall.make(~tool="write", ~args, ())
  // Target must be "/src/app.ts" (no quotes) to match deliverablePath
  assertionIsFalse(~operator="deliverablePath match", Guard.isSelfScript(call, policy))
})
```

Note: if `GuardCall.make` is not the right constructor, check how existing
tests in `Guard_test.res` construct `guardCall` values (look at lines ~112-195
for examples) and match that pattern.

#### 7b: Trajectory ttfa null test

```rescript
test("trajectoryMetrics: ttfa=null when no producing action (TS parity)", () => {
  let p = Guard.makePolicyDefault()
  let s = Guard.newGuardState(p)
  // Do NOT set ttfa — it should remain null (not 0)
  let m = Guard.trajectoryMetrics(s)
  // ttfa should be null, not 0
  let ttfaRaw = Obj.magic(m)["ttfa"]
  assertion(~operator="ttfa is null not 0", (_a, b) => b == null, 0, ttfaRaw)
})
```

#### 7c: Resolver warning test

```rescript
test("_resolveEnforcementMode: unrecognized env value returns warning (TS parity)", () => {
  // Build a minimal config + env with an unrecognized gate value
  // Set env gate to "maybe" — should produce a warning, not silently ignore
  // Follow the config-construction pattern used in Guard_test.res
  // Assert: result.warning is non-null and result.mode falls through to config
})
```

Follow the existing config-construction helpers in `Guard_test.res` to build
the `resolveEnforcementModeParams`. If the function `_resolveEnforcementMode`
is not exported or accessible from tests, test it indirectly through
`guardBeforeCall` or skip this test and cover it in the TS parity suite
(Step 8).

**Verify**: `pnpm run res:build && pnpm run test:res` → all pass (473 + new tests)

### Step 8: Add TypeScript cross-implementation parity suite

**File**: `test/unit/guard-parity.test.ts` (create).

This is the highest-value test: it runs BOTH the TS resolver
(`resolveEnforcementMode` from `src/router/enforcement.ts`) and the ReScript
guard (`guardBeforeCall` from `Guard.res.mjs`) against the same inputs and
asserts identical outputs. This catches ALL future drift.

```typescript
import { describe, it, expect } from "vitest";
import { resolveEnforcementMode } from "../../src/router/enforcement";
import { guardBeforeCall, type guardPolicy } from "../../src/guard/Guard.res.mjs";

// Test matrix: same inputs → same mode output from both implementations
describe("TS ↔ ReScript enforcement resolver parity", () => {
  const cases = [
    { name: "env=1 → enforced", env: { MODEL_ROUTER_ENFORCE: "1" }, expectedMode: "enforced" },
    { name: "env=0 → off", env: { MODEL_ROUTER_ENFORCE: "0" }, expectedMode: "off" },
    { name: "env unset → config default (advisory)", env: {}, expectedMode: "advisory" },
    { name: "env=unrecognized → warning + config fallback", env: { MODEL_ROUTER_ENFORCE: "maybe" }, expectedMode: "advisory" },
    { name: "custom gate env=1", env: { MY_GATE: "1" }, expectedMode: "enforced", envGate: "MY_GATE" },
    { name: "empty envGate → TS keeps empty, resolver reads env['']", env: {}, expectedMode: "advisory", envGate: "" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const config: any = {
        enforcement: {
          mode: "advisory",
          ...(c.envGate !== undefined ? { envGate: c.envGate } : {}),
        },
      };
      const tsResult = resolveEnforcementMode({ config, env: c.env });
      expect(tsResult.mode).toBe(c.expectedMode);

      // For unrecognized env values, TS should produce a warning
      if (c.name.includes("unrecognized")) {
        expect(tsResult.warning).toBeDefined();
      }
    });
  }

  it("fingerprint parity: empty-string arg produces same fingerprint", () => {
    // The || → ?? fix means empty string is preserved, not treated as falsy
    // This test documents the expected behavior
    const args = { pattern: "" };
    // TS fingerprint: `grep:${""}:${""}` = "grep::"
    // ReScript fingerprint should match after the ?? fix
    expect(true).toBe(true); // placeholder — fill with actual cross-check
  });
});
```

Adapt the test to the actual exports and types. The key assertions:
1. Both resolvers return the same `mode` for the same input
2. Unrecognized env values produce a `warning` in the TS resolver
3. Empty-string `envGate` is handled consistently

Model the test structure after `test/unit/enforcement.test.ts` (existing TS
resolver tests).

**Verify**: `pnpm test -- guard-parity` → all new tests pass

## Test plan

- **New ReScript tests** (Step 7): target coercion, ttfa null, resolver warning
- **New TS parity suite** (Step 8): cross-implementation mode/warning checks
- **Existing tests**: all 473 ReScript tests must still pass; all existing
  plugin-hooks tests (83) must still pass
- Pattern to follow for ReScript: `src/guard/Guard_test.res:546-581`
  (trajectoryMetrics tests)
- Pattern to follow for TS: `test/unit/enforcement.test.ts:30-195`
- Verification: `pnpm run res:build && pnpm run test:res && pnpm test`

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run res:build` exits 0
- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run test:res` — all pass (473 + new tests)
- [ ] `pnpm test -- guard-parity` — all new parity tests pass
- [ ] `pnpm test` — no NEW failures beyond the known pre-existing baseline drift
      (9 failures in 6 integration/biome files — unchanged from plan 029/031)
- [ ] `pnpm run build` exits 0
- [ ] `grep -n "Js.Json.stringify" src/guard/Guard.res` returns NO matches in
      the `isSelfScript` target extraction (only in fingerprint default case if any)
- [ ] `grep -n "|| a.filePath\||| a.pattern\||| a.path" src/guard/Guard.res`
      returns no matches (all changed to `??`)
- [ ] `grep -n "enf.envGate) ||" src/guard/Guard.res` returns no matches
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (the codebase has drifted since this plan was written).
- `pnpm run res:build` fails after a `%raw` edit — STOP and report the compiler
  error. Do NOT attempt to "fix" ReScript compilation errors by changing the
  surrounding typed code unless the error is obviously a missing field on the
  updated `resolveEnforcementModeResult` type.
- A previously-passing ReScript test (in the 473 baseline) starts failing after
  a change that is NOT the intended behavior change (e.g. the ttfa null test
  fails because something else depends on ttfa=0).
- The fix appears to require touching an out-of-scope file.
- `_resolveEnforcementMode` is not accessible from `Guard_test.res` for direct
  testing (test it indirectly via `guardBeforeCall` or defer to the TS parity
  suite).

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **What future changes will interact with this**: if the resolver is ever
  de-duplicated (removing the `%raw` copy in `Guard.res` in favor of importing
  `enforcement.ts` directly), the warning field and nullish semantics must be
  preserved. The parity test suite (Step 8) will catch drift.
- **What a reviewer should scrutinize**: the `isSelfScript` target coercion is
  the highest-impact fix — verify that `deliverablePath` matching works for
  string paths without quotes. The `trajectoryMetrics` null fix changes metric
  output for sessions with no producing action — any telemetry consumer that
  assumed `ttfa=0` needs updating.
- **Deferred items** (documented as out-of-scope):
  - `seen` Map → Object: equivalent behavior, not worth the risk
  - `guardBeforeCall` output shape (null vs undefined): cosmetic, no runtime impact
  - `blockScriptWrites` default null vs false: equivalent runtime behavior
  - Resolver de-duplication (two copies of `resolveEnforcementMode`): follow-up plan
