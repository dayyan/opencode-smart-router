# Plan 031: Pass Only the Configured Env-Gate Variable Into Guard Evaluation

> **Executor instructions**: Follow this plan step by step. This plan touches
> the same file as Plan 029 (`tool-guards.ts`); land 029 FIRST, then 031, on
> the same branch or merged sequentially to avoid conflicts.
>
> **Drift check**: `git diff --stat c809a0e..HEAD -- src/plugin/hooks/tool-guards.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW–MED
- **Depends on**: Plan 029 (same-file sequencing; 029 edits the catch block, 031 edits env construction)
- **Category**: security (least-privilege boundary)
- **Planned at**: commit `c809a0e`, 2026-08-08

## Why this matters

`src/plugin/hooks/tool-guards.ts:322-325` copies the **entire** `process.env`
into the `env` parameter of `guardBeforeCall`:

```ts
env: Object.fromEntries(
  Object.entries(process.env).map(([k, v]) => [k, v ?? null]),
) as Record<string, string | null>,
```

That object carries every secret the host process owns: provider API keys
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), cloud credentials
(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), database connection strings,
and anything else in the environment.

The guard reads **exactly one** key. `src/guard/Guard.res:561-575`
(`_resolveEnforcementMode`):

```res
let gateName = (enf && enf.guard && enf.guard.envGate) || 'MODEL_ROUTER_ENFORCE';
let raw = params.env && params.env[gateName];
if (raw === '1') return { mode: 'enforced' };
if (raw === '0') return { mode: 'off' };
```

No other env key is read by the guard. Every other secret crosses an internal
boundary for no functional reason — widening the blast radius if any future
logging, trajectory, or error-reporting change inside the guard path ever
serializes `env` or a structure derived from it. Least-privilege: pass only
the key the guard actually needs.

## Current state

- Hook caller: `src/plugin/hooks/tool-guards.ts:322-325` (full `process.env`).
- Guard consumer: `src/guard/Guard.res:561-575` reads only `env[gateName]`.
- The gate name is configurable: `cfg.enforcement?.guard?.envGate` (default
  `"MODEL_ROUTER_ENFORCE"`), per `src/router/config.types.ts:57-68`.

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

- `src/plugin/hooks/tool-guards.ts` (env construction in `runSubagentGuard`).
- `test/unit/tool-guards.test.ts` (or nearest hook test) — add a minimal-env
  assertion.

**Out of scope**:

- `src/guard/Guard.res` — NO ReScript change; the signature stays
  `env: Record<string,string|null>`.
- Any other caller of `guardBeforeCall`.
- `src/guard/scrub.ts` — separate concern.
- Plan 029's catch-block change in the same file.

## Steps

### Step 1: Confirm the guard reads only the gate key

Before changing the call, verify no other `Guard.res` function reads a second
env var. Grep the ReScript source:

```bash
rg -n "env\b|Env\b" src/guard/Guard.res
```

The audit found only `_resolveEnforcementMode` reads `env`. If this grep
reveals a second reader, STOP (see STOP conditions) and widen the allowlist
explicitly rather than reverting to full `process.env`.

### Step 2: Read the gate name from cfg and build a minimal env

In `runSubagentGuard`, replace the full-`process.env` spread with a one-key
object:

```ts
const cfg = await ctx.getConfig();
const gateName = cfg.enforcement?.guard?.envGate ?? "MODEL_ROUTER_ENFORCE";
const guardEnv: Record<string, string | null> = {
  [gateName]: process.env[gateName] ?? null,
};
// ... pass env: guardEnv into guardBeforeCall
```

If Plan 029 already restructured this function (it resolves cfg before the
try), reuse that `cfg` reference — do not read cfg twice.

### Step 3: Add a test asserting minimal env shape

Add a unit test that captures the `env` argument passed into `guardBeforeCall`
(via the existing test seam / fake) and asserts:

- It contains exactly one key.
- That key equals the configured `envGate` (or `"MODEL_ROUTER_ENFORCE"` by
  default).
- It does NOT contain `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / arbitrary keys.

**Verify**: `pnpm test -- tool-guards plugin-hooks` — all pass.

### Step 4: Run the full evidence path

```bash
pnpm run typecheck
pnpm run lint
pnpm test
```

Expected: all exit 0. Enforcement `'0'` / `'1'` / default resolution behavior
is unchanged (the guard still sees the gate value it needs).

## Done criteria

- [ ] The `env` passed to `guardBeforeCall` contains only the configured gate
      key (default `"MODEL_ROUTER_ENFORCE"`).
- [ ] No `process.env` wholesale copy remains in `runSubagentGuard`.
- [ ] Enforcement mode resolution behaves identically (`'1'`→enforced,
      `'0'`→off, default→config).
- [ ] A test proves the minimal-shape env (no API keys leak through).
- [ ] `pnpm run typecheck`, `pnpm run lint`, `pnpm test` pass.
- [ ] No files outside Scope are modified.

## STOP conditions

Stop and report instead of improvising if:

- Step 1's grep reveals a second env var read in `Guard.res` — widen the
  allowlist to exactly the set of keys the guard reads; do NOT revert to
  spreading all of `process.env`.
- The test seam cannot observe the `env` argument passed into
  `guardBeforeCall` — report so the test strategy can be adjusted; do not
  skip the test.
- A test or build fails twice after a targeted correction.

## Maintenance notes

- If enforcement later adds a second env-gated feature, add that key to the
  allowlist here explicitly — never revert to spreading `process.env`.
- The allowlist is the security boundary: review it whenever the guard's env
  contract changes. It is cheaper to audit a one-line allowlist than a full
  `process.env` copy.
