# Proposal: user-owned-reasoning-profiles

> **Bootstrap registration.** This change is registered via the openspec file
> store because the engram artifact store has no change-root creation primitive
> in gentle-ai v2.4.0 (verified 2026-08-30). The binding requirements input is
> the committed plan file; this proposal does not re-open any decision marked
> DECIDED there.

## Summary

Replace the hardcoded four-grade reasoning vocabulary
(`minimal|normal|elevated|max`), the hardcoded provider-variant sets
(`POSITIONAL_VARIANTS`/`NAMED_VARIANTS`), and the lossy `DISCRETE_RANK` rank
math with two user-owned vocabularies in `tiers.json`: opaque **profile IDs**
(what "how much reasoning" means) and per-tier **native levels** (the exact
values each tier's current model accepts), bridged by a per-tier
`reasoningControl.profileMap` and gated by a per-tier `maxBumps`. Code never
interprets names; array order is the only semantics.

## Binding input

- `plans/041-user-owned-reasoning-profiles.md` at commit `0ea3822` — the
  requirements input. Its **DECIDED** section (lines 211–242) is binding and
  must not be re-opened in spec, design, or tasks.
- Design decisions **D-1 … D-4** (plan lines 391–408) are resolved in the
  design phase, not here.

## Why

- An unknown provider variant silently degrades to `kind: "none"` with no
  error, so a model swap quietly removes reasoning control.
- Provider level renames (e.g. DeepSeek `[low,medium,high,max]` →
  `[low,high,max]`) currently require router code changes.
- The normalized 4-grade set collapses lossily onto 3-level ladders.
- Bump enablement is a single global switch; tiers cannot opt out.

## Scope

**In scope**: `src/reasoning/{capability,translate,policy,adaptive,store}.ts`,
`src/router/{config.types,config-validate}.ts`, `src/escalate/ladder.ts`,
`src/plugin/delegate.ts`, `src/router/commands/{builders,dispatch}.ts`,
`src/plugin/hooks/tool-guards.ts` (call-sites only),
`config/tiers/{base,presets}.json`, `scripts/build-tiers-config.ts`,
`tiers.json` (regenerated), reasoning sections of
`docs/{REASONING,CONFIG_REFERENCE,ESCALATION}.md` + `README.md`, and the test
files listed in plan 041 (incl. new
`test/unit/no-hardcoded-reasoning-vocabulary.test.ts`).

**Out of scope**: `src/verify/**`, `src/guard/**`, tier-selection routing
(`checker.ts`, `sessions.ts`, `TierLadder.res`), cost ceiling,
`maxAttemptsPerTier`/`maxTotalAttempts` semantics, abort handling,
`src/router/agents.ts` behavior, ReScript guard/ladder logic.

## Success criteria

The 9 machine-checkable Done criteria from plan 041 lines 620–629 (SC-1…SC-9),
including: typecheck/test/test:res/build green, zero hardcoded-vocabulary
identifiers in `src/`, `reasoningEscalation` absent from `tiers.json`/`config/`,
all bundled presets shipping `maxBumps: 0`, no out-of-scope files touched, SDD
verify PASS.

## Risks

- R-1 breaking migration: invalid v2 reloads must keep the previous config
  active (existing config-store behavior).
- R-2 bundled profile IDs (`light/standard/deep`) are config data, never code
  constants; tests use their own fixture IDs.
- R-3 `scripts/build-tiers-config.ts` MERGE_PLAN allow-list coupling (obs
  #4141): removing `enforcement.escalate.reasoningEscalation` from `base.json`
  requires the allow-list update in the same change.
- R-4 anti-hardcoding test (plan Step 11) must be green from its first run.
- R-5 ReScript parity: verified clean 2026-08-30 (no `.res`/`.resi` hits for
  the bump/reasoning identifiers); no ReScript port needed.

## Status

- Proposal: **registered** (bootstrap, 2026-08-30).
- Next phase: **spec** — turn plan 041 "Target design" + "Validation
  invariants" into requirements/scenarios; then design (D-1…D-4), tasks,
  apply, verify, archive.
- Branch target: `advisor/041-user-owned-reasoning-profiles`, worktree
  `/tmp/opencode/smart-router-041`, from `0ea3822`.
