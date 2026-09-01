# Delta for reasoning-config

> Source: plan 041 "Validation invariants", DECIDED 5 (breaking migration),
> Steps 8 and 11. Test mapping: vitest suites
> `test/unit/config-validate-sections.test.ts`, `tiers-assembly.test.ts`,
> `router-config.test.ts`, `no-hardcoded-reasoning-vocabulary.test.ts` (new).

## ADDED Requirements

### Requirement: Fail-Fast Validation Invariants

Validation MUST reject with `tiers.json:`-prefixed errors, preserving the permissive-skip convention: malformed `profiles` (empty, duplicated, or empty-string entries); `profiles` missing while any tier has `reasoningControl` or mode ≠ `static`; mode `manual`/`adaptive` without `profiles` and `defaultProfile`; any reference (`defaultProfile`, non-null `trivialProfile`, `tierProfileDefaults.*`, `rules[].profile`) to an unregistered ID; any `reasoningControl` violation — bad `channel`, empty `levels`, duplicate or empty string levels, non-ascending or negative budget levels, `profileMap` keys ≠ registry (missing AND extra), mapped value ∉ `levels` (strict equality), `maxBumps` non-integer or outside `0 … levels.length − 1`; bump fields on a tier without `reasoningControl`. Keyword grammar validation (non-empty keywords, `match` modes, fail-fast regex compile) carries over with `profile` in place of `level`.

#### Scenario: profileMap must equal the registry exactly

- GIVEN a registry of three profiles and a control mapping only two
- WHEN validation runs
- THEN it fails for the missing profile, and fails separately for an extra key

#### Scenario: Budget levels must ascend

- GIVEN budget levels `[4096, 1024]`
- WHEN validation runs
- THEN it fails as non-ascending

#### Scenario: maxBumps must fit the ladder

- GIVEN three levels and `maxBumps: 3`
- WHEN validation runs
- THEN it fails because the maximum is `levels.length − 1`

#### Scenario: manual mode needs registry and default

- GIVEN mode `manual` without `defaultProfile`
- WHEN validation runs
- THEN it fails

### Requirement: Legacy Keys Are Validation Errors

`enforcement.escalate.reasoningEscalation` is removed: its presence MUST be a validation error pointing at the migration note in the docs. `TierConfig.capability` is removed. No runtime compatibility inference of old capability/level shapes may exist.

#### Scenario: Legacy escalation block rejected with pointer

- GIVEN a config containing `enforcement.escalate.reasoningEscalation`
- WHEN validation runs
- THEN it fails and the message points at the migration docs

### Requirement: Invalid Reload Keeps Previous Config

Migration is breaking by design. On a reload whose v2 document is invalid, the config store MUST keep the previously active configuration (existing behavior); no partial application.

#### Scenario: Invalid v2 reload is atomic

- GIVEN a valid active config and an invalid v2 replacement document
- WHEN the reload is attempted
- THEN the previous config remains active and the error is reported

### Requirement: Bundled Presets Ship Bumping Disabled

Every bundled tier MUST ship either no `reasoningControl` or `"maxBumps": 0`; operators opt into bumping per tier afterwards. Bundled profile IDs (`light`, `standard`, `deep`) are config data and MUST NOT be referenced from code; tests of runtime logic MUST use their own fixture IDs. Removing the legacy escalation key from `config/tiers/base.json` MUST update the generator allow-list, assembly tests, and golden snapshots in the same change; regenerated `tiers.json` MUST contain only the v2 reasoning shape.

#### Scenario: All bundled presets have bumping disabled

- GIVEN the regenerated `tiers.json`
- WHEN each bundled tier is inspected
- THEN each has no `reasoningControl` or `maxBumps: 0`, and `reasoningEscalation` appears nowhere in `tiers.json` or `config/`

### Requirement: No Hardcoded Vocabulary Regression

Source MUST NOT contain the identifiers `ReasoningLevel`, `DISCRETE_RANK`, `inferCapability`, `POSITIONAL_VARIANTS`, `NAMED_VARIANTS`, `reasoningEscalation`, `maxLevelBumpsPerTier`, or `REASONING_LEVELS`; the literals `"minimal"` and `"elevated"` MUST NOT appear in `src/reasoning/` or `src/router/`. A regression test MUST enforce this invariant and be green from its first run.

#### Scenario: Anti-hardcoding test passes from first run

- GIVEN the source tree after migration
- WHEN the anti-hardcoding regression suite runs
- THEN it finds none of the banned identifiers and passes
