# Delta for reasoning-profiles

> Source: plan 041 "Target design" (DECIDED 1, 6). Test mapping: vitest suites
> `test/unit/reasoning-policy.test.ts`, `adaptive-selector.test.ts`,
> `router-commands.test.ts` (fixture profile IDs, never bundled IDs).

## ADDED Requirements

### Requirement: Opaque Profile Registry

`reasoningPolicy.profiles` SHALL be the closed registry of reasoning-intent IDs owned by `tiers.json`. Profile IDs MUST be opaque: runtime code MUST NOT interpret, special-case, or enumerate their names; registry membership SHALL be the only validity criterion. No bundled profile ID may appear as a code constant.

#### Scenario: Fixture profile IDs resolve without name knowledge

- GIVEN a config registering fixture profiles `["p1", "p2", "p3"]`
- WHEN each registered profile is selected
- THEN resolution succeeds with no name-specific branching in code

#### Scenario: Unregistered reference rejected

- GIVEN a config whose `defaultProfile` is absent from `profiles`
- WHEN validation runs
- THEN it fails with a `tiers.json:`-prefixed error

### Requirement: Mode-Preserving Profile Resolution

Selection MUST preserve existing mode semantics with profiles in place of levels: `static` → no selection and no runtime patch; `manual` → session override ?? `defaultProfile`; `adaptive` → override wins, then selector signals, then `defaultProfile`. Unknown mode MUST fail-soft to no selection. `surfaceLimits` and `adaptive.surfaceDecision` surfacing is preserved. The task-tool hook path and the delegate path MUST resolve identically for the same policy, override, and signals.

#### Scenario: static selects nothing

- GIVEN mode `static` with a control-bearing tier
- WHEN a request is dispatched
- THEN no reasoning patch is applied and the static baseline serves

#### Scenario: manual uses override then default

- GIVEN mode `manual` with `defaultProfile: "p2"` and no session override
- WHEN selection runs
- THEN `"p2"` is selected, and with override `"p1"` set, `"p1"` wins

#### Scenario: adaptive override beats selector

- GIVEN mode `adaptive` with an override set and selector signals present
- WHEN selection runs
- THEN the override is selected regardless of signals

#### Scenario: Unknown mode fails soft

- GIVEN an unrecognized `mode` value
- WHEN selection runs
- THEN no profile is selected and no patch is applied

#### Scenario: Delegate path resolves like the hook path

- GIVEN the same policy, parent-session override, and task-text signals
- WHEN both the task-tool hook path and the delegate path resolve
- THEN both produce the same profile

### Requirement: Session Override Store Holds Opaque Strings

Session overrides MUST be stored as opaque strings. A persisted override that is not a registered profile ID MUST be ignored — control returns to the configured policy — and a `reasoning.override_unknown_profile` event MUST be logged. `/model-router-reasoning off` MUST clear the override, returning control to the configured policy (unchanged meaning).

#### Scenario: Unknown persisted override ignored

- GIVEN a stored override `"p9"` and a config whose registry lacks `"p9"`
- WHEN the session resumes and selection runs
- THEN the policy resolves selection and `reasoning.override_unknown_profile` is logged

#### Scenario: off clears the override

- GIVEN a session override is set
- WHEN `/model-router-reasoning off` runs
- THEN the override is cleared and the configured policy governs

### Requirement: Adaptive Selector Targets Profile IDs

Selector decision order MUST be preserved: (1) trivial signal → `trivialProfile` ?? none; (2) `tierProfileDefaults[tier]`; (3) keyword rules, first match wins, same match grammar (`word|stem|substring|regex`, `excludeKeywords`); (4) `defaultProfile` ?? none. Rule consequences MUST be profile IDs.

#### Scenario: Decision order preserved

- GIVEN signals matching both a tier default and a keyword rule
- WHEN the selector runs
- THEN the tier default wins (step 2 precedes step 3)

#### Scenario: Keyword rule selects its profile

- GIVEN a prompt matching a rule's keywords with `profile: "p2"`
- WHEN the selector runs and no earlier step matched
- THEN `"p2"` is selected

### Requirement: Reasoning Command Accepts Registered IDs Only

`/model-router-reasoning` MUST list and accept only registered profile IDs or `off`; the listed vocabulary MUST derive from the registry, not from code. Tier descriptions MUST render the tier's `reasoningControl` — channel, ordered levels, `maxBumps` — when present.

#### Scenario: Command vocabulary is registry-driven

- GIVEN a registry `["p1", "p2"]`
- WHEN `/model-router-reasoning` renders
- THEN exactly `p1`, `p2`, and `off` are offered

#### Scenario: Unregistered argument rejected

- GIVEN a registry `["p1", "p2"]`
- WHEN the command receives `"max"`
- THEN it is rejected as not a registered profile
