# Plan 035: Add unit tests for config-loader pure functions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5e1810f..HEAD -- src/router/config-loader.ts src/router/config-errors.ts src/router/config.types.ts src/router/config-paths.ts src/router/config-resolve.ts src/router/enforcement.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `5e1810f`, 2026-08-10

## Why this matters

`src/router/config-loader.ts` exports three pure functions — `readConfigLayer`,
`deepMergeConfig`, and `applyStateOverlay` — that are the backbone of the
plugin's config pipeline. Every tier resolution, enforcement mode, and
reasoning policy decision flows through them. Today these functions are
exercised **only indirectly** through integration tests
(`config-store.test.ts`, `config-async.test.ts`, `router-command.test.ts`),
which focus on the store/cache contract, not on layer-level error paths or
merge semantics.

The gap means a regression in error classification (e.g. a malformed-JSON
path silently returning `undefined` instead of throwing), a merge-precedence
bug (e.g. scalar override breaking), or a state-overlay validation failure
(e.g. an invalid `enforcementMode` leaking through) would not be caught by
any direct unit test. This plan adds focused unit tests for each function's
documented contract — every error kind, every merge rule, every overlay field
— so these regressions are caught at the unit level, fast and isolated.

## Current state

### File under test: `src/router/config-loader.ts`

**Exports the three functions this plan targets:**

```typescript
// Line 128 — reads a single config layer from disk.
export const readConfigLayer = async (
  layer: ConfigLayer,
): Promise<Record<string, unknown> | undefined> => { ... }

// Line 206 — deep-merge two config-shaped values.
export const deepMergeConfig = (base: unknown, override: unknown): unknown => { ... }

// Line 246 — overlay persisted runtime state onto a validated config.
export const applyStateOverlay = (cfg: RouterConfig, state: RouterState): void => { ... }
```

**`readConfigLayer` error-handling branches (lines 128–183):**

```typescript
// ENOENT on a required layer → kind="unreadable"
// ENOENT on an optional layer → warnAndSkip + return undefined
// Non-ENOENT read error → kind="unreadable"
// JSON.parse failure → kind="malformed"
// Non-object root (array/null/string) → kind="malformed"
// Success → return parsed object
```

**`deepMergeConfig` merge rules (lines 206–217):**

```typescript
export const deepMergeConfig = (base: unknown, override: unknown): unknown => {
  if (base === undefined) return override;
  if (override === undefined) return base;
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      result[key] = deepMergeConfig(base[key], override[key]);
    }
    return result;
  }
  return override;  // scalars, arrays, null → override replaces base
};
```

**`applyStateOverlay` overlay fields (lines 246–265):**

```typescript
export const applyStateOverlay = (cfg: RouterConfig, state: RouterState): void => {
  if (state.activePreset) {
    const resolved = resolvePresetName(cfg, state.activePreset);
    if (resolved) cfg.activePreset = resolved;
  }
  if (state.activeMode && cfg.modes?.[state.activeMode]) {
    cfg.activeMode = state.activeMode;
  }
  if (state.enforcementMode && isValidEnforcementMode(state.enforcementMode)) {
    cfg.enforcement = { ...(cfg.enforcement ?? {}), mode: state.enforcementMode };
  }
  if (state.reasoningMode && isValidReasoningMode(state.reasoningMode)) {
    cfg.reasoningPolicy = { ...(cfg.reasoningPolicy ?? {}), mode: state.reasoningMode };
  }
};
```

### Supporting types: `src/router/config.types.ts`

```typescript
// Line 244
export type ConfigLayer = {
  kind: "bundled" | "global" | "local";
  path: string;
  required: boolean;
};

// Line 231
export interface RouterState {
  activePreset?: string;
  activeMode?: string;
  enforcementMode?: "off" | "advisory" | "enforced";
  reasoningMode?: "static" | "manual" | "adaptive";
}

// Line 210 — RouterConfig (see file for full interface)
export interface RouterConfig {
  activePreset: string;
  activeMode?: string;
  presets: Record<string, Preset>;
  rules: string[];
  defaultTier: string;
  enforcement?: EnforcementConfig;
  reasoningPolicy?: ReasoningPolicyConfig;
  // ... other fields
}
```

### Error class: `src/router/config-errors.ts`

```typescript
// Line 63
export class RouterConfigError extends Error {
  override readonly name = "RouterConfigError";
  readonly kind: ConfigErrorKind;  // "missing" | "unreadable" | "malformed" | "invalid" | "stale_refresh_failed"
  readonly path: string;
  constructor(kind: ConfigErrorKind, path: string, cause: unknown, message?: string) { ... }
}
```

### Test exemplar: `test/unit/config-store.test.ts`

This is the existing test that exercises `readMergedConfig` indirectly via
`createConfigStore`. Model the temp-dir setup and path-reset pattern after it:

```typescript
// Lines 31-53 — beforeEach pattern
beforeEach(async () => {
  origHOME = process.env.HOME;
  // ... save env vars ...
  tmpHome = join(tmpdir(), `oc-store-${process.pid}-${Date.now()}-...`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.HOME = tmpHome;
  delete process.env.XDG_CONFIG_HOME;
  tmpCwd = join(tmpHome, "cwd");
  mkdirSync(tmpCwd, { recursive: true });
  process.chdir(tmpCwd);
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});
```

## Commands you will need

| Purpose   | Command                                  | Expected on success |
|-----------|------------------------------------------|---------------------|
| Typecheck | `pnpm run typecheck`                     | exit 0, no errors   |
| Tests     | `pnpm test -- test/unit/config-loader.test.ts` | all pass     |
| Full suite| `pnpm test`                              | all pass            |
| Lint      | `pnpm run lint`                          | exit 0              |

## Scope

**In scope** (the only file you should modify):
- `test/unit/config-loader.test.ts` (create)

**Out of scope** (do NOT touch):
- `src/router/config-loader.ts` — production code is correct; this plan adds tests only.
- `test/unit/config-store.test.ts` — already covers the store/caching contract.
- Any other source or test file.

## Git workflow

- Branch: `advisor/035-config-loader-tests`
- Commit style: conventional commits (e.g. `test(config-loader): add unit tests for readConfigLayer, deepMergeConfig, applyStateOverlay`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the test file with temp-dir setup

Create `test/unit/config-loader.test.ts`. Copy the `beforeEach`/`afterEach`
temp-dir pattern from `test/unit/config-store.test.ts:31-67` (save/restore
HOME, USERPROFILE, XDG_CONFIG_HOME, cwd; create temp dirs; call
`__resetPathsForTest()`). Import:

```typescript
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readConfigLayer,
  deepMergeConfig,
  applyStateOverlay,
} from "../../src/router/config-loader";
import { RouterConfigError } from "../../src/router/config-errors";
import type { ConfigLayer, RouterConfig, RouterState } from "../../src/router/config.types";
```

**Verify**: `pnpm run typecheck` → exit 0 (file compiles with no type errors).

### Step 2: Test `readConfigLayer` error paths

Add a `describe("readConfigLayer")` block. For each case, write a real file
into `tmpHome` (or omit it) so the `readFile` call hits real filesystem
behavior. This avoids mocking complexity and matches the `config-store.test.ts`
pattern.

Test cases (one `it` per case):

1. **Required layer missing (ENOENT)** — layer `{ kind: "bundled", path:
   join(tmpHome, "missing.json"), required: true }` → `await
   expect(readConfigLayer(layer)).rejects.toThrow(RouterConfigError)` and the
   error's `kind` is `"unreadable"`.

2. **Optional layer missing (ENOENT)** — layer `{ kind: "global", path:
   join(tmpHome, "absent.json"), required: false }` → `const result = await
   readConfigLayer(layer)` → `expect(result).toBeUndefined()`.

3. **Malformed JSON** — `writeFileSync(path, "{not valid json")` → rejects
   with `RouterConfigError` whose `kind` is `"malformed"`.

4. **Non-object root: array** — `writeFileSync(path, "[1,2,3]")` → rejects
   with `RouterConfigError` whose `kind` is `"malformed"`.

5. **Non-object root: null** — `writeFileSync(path, "null")` → rejects with
   `RouterConfigError` whose `kind` is `"malformed"`.

6. **Valid object** — `writeFileSync(path, JSON.stringify({ key: "value"
   }))` → `const result = await readConfigLayer(layer)` →
   `expect(result).toEqual({ key: "value" })`.

For the reject assertions, use this pattern to check the `kind`:

```typescript
try {
  await readConfigLayer(layer);
  expect.unreachable("should have thrown");
} catch (err) {
  expect(err).toBeInstanceOf(RouterConfigError);
  expect((err as RouterConfigError).kind).toBe("unreadable");  // or "malformed"
}
```

**Verify**: `pnpm test -- test/unit/config-loader.test.ts` → all pass.

### Step 3: Test `deepMergeConfig` merge semantics

Add a `describe("deepMergeConfig")` block. These are pure function calls —
no filesystem setup needed. Test cases:

1. **`undefined` base returns override** — `deepMergeConfig(undefined, {
   a: 1 })` → `{ a: 1 }`.
2. **`undefined` override returns base** — `deepMergeConfig({ a: 1 },
   undefined)` → `{ a: 1 }`.
3. **Both `undefined`** — `deepMergeConfig(undefined, undefined)` →
   `undefined`.
4. **Scalar override replaces base** — `deepMergeConfig(42, "hello")` →
   `"hello"`.
5. **`null` is a scalar, not merged** — `deepMergeConfig({ a: 1 }, null)`
   → `null`.
6. **Arrays replace, not concatenate** — `deepMergeConfig([1, 2], [3])` →
   `[3]`.
7. **Recursive merge by key union** — `deepMergeConfig({ a: { x: 1, y: 2
   } }, { a: { y: 9, z: 3 } })` → `{ a: { x: 1, y: 9, z: 3 } }`.
8. **Nested scalar override in object** — `deepMergeConfig({ a: { b: 1 }
   }, { a: 42 })` → `{ a: 42 }`.

**Verify**: `pnpm test -- test/unit/config-loader.test.ts` → all pass.

### Step 4: Test `applyStateOverlay` overlay behavior

Add a `describe("applyStateOverlay")` block. Build a minimal `RouterConfig`
fixture and `RouterState` partial, then assert `cfg` was mutated correctly.
Use this fixture builder:

```typescript
const makeCfg = (): RouterConfig => ({
  activePreset: "default",
  defaultTier: "medium",
  presets: { default: {} },
  rules: [],
  modes: { coding: { defaultTier: "fast", description: "" } },
});
```

Test cases:

1. **Valid `activePreset` is applied** — state `{ activePreset: "default" }`
   → `cfg.activePreset` remains `"default"` (resolvePresetName canonicalizes
   the name; test with a preset that exists).
2. **Invalid `activePreset` is ignored** — state `{ activePreset:
   "nonexistent" }` → `cfg.activePreset` unchanged (the `if (resolved)`
   guard prevents the write).
3. **Valid `activeMode` is applied** — state `{ activeMode: "coding" }` →
   `cfg.activeMode === "coding"`.
4. **Invalid `activeMode` is ignored** — state `{ activeMode: "unknown" }`
   → `cfg.activeMode` unchanged.
5. **Valid `enforcementMode` is applied** — state `{ enforcementMode:
   "enforced" }` → `cfg.enforcement.mode === "enforced"`.
6. **Invalid `enforcementMode` is ignored** — state `{ enforcementMode:
   "bogus" as any }` → `cfg.enforcement` unchanged.
7. **Valid `reasoningMode` is applied** — state `{ reasoningMode: "manual"
   }` → `cfg.reasoningPolicy.mode === "manual"`.
8. **Invalid `reasoningMode` is ignored** — state `{ reasoningMode: "bogus"
   as any }` → `cfg.reasoningPolicy` unchanged.
9. **Empty state is a no-op** — state `{}` → `cfg` deep-equals the input
   (assert with `JSON.stringify` or key-by-key).
10. **`enforcement` created if absent** — start from a cfg with
    `enforcement: undefined`, apply state `{ enforcementMode: "enforced" }`
    → `cfg.enforcement` is defined and `mode === "enforced"`.

**Verify**: `pnpm test -- test/unit/config-loader.test.ts` → all pass.

### Step 5: Run full verification suite

Run the full test suite, typecheck, and lint to confirm no regressions:

```
pnpm run typecheck && pnpm test && pnpm run lint
```

**Verify**: all three exit 0.

## Test plan

- **File**: `test/unit/config-loader.test.ts` (new).
- **Cases**: 6 for `readConfigLayer`, 8 for `deepMergeConfig`, 10 for
  `applyStateOverlay` = **24 total**.
- **Structural pattern**: model after `test/unit/config-store.test.ts`
  (temp-dir setup, `writeFileSync` for staging, `__resetPathsForTest()`).
- **Verification**: `pnpm test -- test/unit/config-loader.test.ts` → all 24
  pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm test` exits 0; new tests for config-loader exist and pass
- [ ] `pnpm run lint` exits 0
- [ ] `test/unit/config-loader.test.ts` exists with ≥24 test cases covering
      readConfigLayer error kinds, deepMergeConfig merge rules, and
      applyStateOverlay overlay fields
- [ ] No files outside `test/unit/config-loader.test.ts` are modified
      (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (the codebase has drifted since this plan was written).
- `readConfigLayer` uses a different error classification than the six
  branches listed (e.g. a new `kind` was added, or the ENOENT logic
  changed).
- `deepMergeConfig` or `applyStateOverlay` signatures changed (e.g.
  additional parameters, different return type).
- `resolvePresetName` rejects a preset name that the plan assumes is valid,
  or accepts one the plan assumes is invalid — adjust the test fixture
  presets accordingly, but STOP if the function itself appears broken.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Future config-layer additions**: if a new layer kind is added (e.g.
  `"enterprise"`), add a corresponding `readConfigLayer` test case.
- **Merge rule changes**: if `deepMergeConfig` gains array-concatenation or
  `__proto__` hardening (see rejected finding in `plans/README.md` audit
  cycle 2), update the array-replace test case and add the new behavior.
- **State overlay expansion**: if `applyStateOverlay` gains a new field
  (e.g. `activeReasoningLevel`), add a corresponding overlay test case.
- **Reviewer focus**: verify that the `RouterConfigError.kind` assertions
  match the error taxonomy in `src/router/config-errors.ts:46-51` — a
  mismatch means either the test or the production code is wrong.
