# Plan 030: Make Coverage a Real Verification Gate

> **Executor instructions**: Follow this plan step by step. The user chose
> option B: a SEPARATE gate script, NOT gating the default `pnpm test` run.
> Keep `pnpm test` fast for iteration; the gate is explicit and opt-in.
>
> **Drift check**: `git diff --stat c809a0e..HEAD -- vitest.config.ts package.json`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (land first to catch coverage regressions from 029/031/022)
- **Category**: test coverage / DX
- **Planned at**: commit `c809a0e`, 2026-08-08

## Why this matters

`vitest.config.ts:33-43` defines coverage thresholds (global 80/85/80/80;
per-directory 90 for guard/verify/router, 95 for escalate/telemetry). But:

1. Line 8-9 marks them "intentionally left non-failing in Wave 0."
2. `package.json:15` (`"test": "vitest run"`) **never collects coverage**, so
   even active thresholds would not gate the default path — only the opt-in
   `test:coverage` (line 17) exercises them.

The result: coverage can silently regress while `pnpm test` stays green. This
plan makes the gate real without slowing down everyday `pnpm test`.

## Current state

```jsonc
// package.json:15-17
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage",
```

```ts
// vitest.config.ts:8-9
// - Coverage source is `src/`. Thresholds are wired but intentionally left
//   non-failing in Wave 0; they are turned on in Phase 5.1.
```

```ts
// vitest.config.ts:33-43
thresholds: {
  statements: 80,
  branches: 85,
  functions: 80,
  lines: 80,
  "src/guard/**/*.ts": { branches: 90, lines: 90, functions: 90 },
  "src/verify/**/*.ts": { branches: 90, lines: 90, functions: 90 },
  "src/router/**/*.ts": { branches: 90, lines: 90, functions: 90 },
  "src/escalate/**/*.ts": { branches: 95, lines: 95, functions: 95 },
  "src/telemetry/**/*.ts": { branches: 95, lines: 95, functions: 95 },
},
```

## Decision (user-selected: option B — separate gate script)

Do NOT change `"test"`. Add a dedicated gate script and wire it into the
publish guard. This preserves fast iteration (`pnpm test`) while making the
coverage gate an explicit, CI-ready command.

## Commands

| Purpose      | Command                                              |
|--------------|------------------------------------------------------|
| Fast tests   | `pnpm test` (unchanged, no coverage)                 |
| Coverage run | `pnpm run test:coverage` (existing)                  |
| Gate run     | `pnpm run test:gate` (NEW — added by this plan)      |
| Typecheck    | `pnpm run typecheck`                                 |
| Lint         | `pnpm run lint`                                      |

## Scope

**In scope**:

- `vitest.config.ts` (remove the stale Wave-0 non-failing caveat; confirm
  thresholds actually fail when coverage is collected).
- `package.json` (add `test:gate` script; chain `prepublishOnly`).

**Out of scope**:

- The threshold **values** — keep current numbers; do not lower them to make
  the gate pass.
- CI workflow file (separate finding).
- `vitest.smoke.config.ts`.

## Steps

### Step 1: Confirm thresholds actually fail the run

In vitest v4, `coverage.thresholds` fail the run by default when coverage is
collected. Verify — do not assume:

```bash
pnpm run test:coverage
```

- If it exits 0: thresholds may be satisfied OR non-failing. Inspect the
  console for a threshold-failure message vs. silent pass.
- If it fails on a threshold: record the current gap as the real baseline.
  **Do not lower thresholds to make it pass.**

If the "non-failing" is implemented via an explicit vitest flag/option, find
and remove it. If vitest v4 fails by default and there is NO special flag,
then the only reason the gate is inert is that the default `pnpm test` does
not collect coverage — which Step 2 fixes by adding the explicit gate script.

### Step 2: Update the stale Wave-0 comment

Replace lines 8-9 of `vitest.config.ts` with an accurate comment stating the
thresholds ARE enforcing whenever coverage is collected (via `test:coverage`
or `test:gate`), and that the default `pnpm test` does not collect coverage
to keep the local loop fast.

### Step 3: Add the gate script

In `package.json` `scripts`, add:

```jsonc
"test:gate": "vitest run --coverage",
```

`test:gate` is semantically the gate: it runs the suite AND enforces coverage
thresholds (exit non-zero on threshold breach). It is distinct from
`test:coverage` only in intent/naming — both run coverage — but `test:gate`
is the canonical "does this branch pass the merge contract?" command. (If the
executor finds that redundant, keep `test:coverage` as the run and make
`test:gate` the documented alias; do NOT delete `test:coverage`.)

### Step 4: Wire the publish guard

Update `prepublishOnly` (`package.json:14`) so a publish cannot ship with a
coverage regression. The build must run before tests (vitest imports stale
`.res.mjs` outputs otherwise — see recon):

```jsonc
"prepublishOnly": "pnpm run build && pnpm run test:gate",
```

### Step 5: Run the full evidence path

```bash
pnpm test              # still fast, no coverage
pnpm run test:gate     # the gate — must pass (or reveal the real baseline)
pnpm run typecheck
pnpm run lint
```

Expected: `pnpm test` is unchanged/fast; `pnpm run test:gate` either passes or
honestly reports a coverage gap.

## Done criteria

- [ ] `pnpm run test:gate` exits non-zero when coverage drops below thresholds.
- [ ] `pnpm test` is unchanged (still fast, no coverage instrumentation).
- [ ] `prepublishOnly` includes the gate.
- [ ] The stale Wave-0 non-failing comment is corrected in `vitest.config.ts`.
- [ ] Threshold values are unchanged.
- [ ] No files outside Scope are modified.

## STOP conditions

Stop and report instead of improvising if:

- `pnpm run test:gate` reveals coverage well below thresholds — report the
  exact gap; do NOT silently lower the numbers (that defeats the gate). The
  maintainer decides whether to raise coverage or (deliberately) relax a
  threshold.
- vitest v4 thresholds require a non-obvious config flag to fail — report it;
  do not guess the API.

## Maintenance notes

- When this plan lands, the merge contract is `pnpm run test:gate` (or CI
  running it once a workflow exists). Document this in README's Testing
  section opportunistically.
- If a future plan adds a CI workflow, that workflow should run
  `pnpm run test:gate` (not bare `pnpm test`) so coverage is enforced on PRs.
- Threshold numbers are a ratchet: only ever raise them as coverage improves.
