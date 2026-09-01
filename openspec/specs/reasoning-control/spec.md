# Delta for reasoning-control

> Source: plan 041 "Target design" (DECIDED 2, 7). Replaces `TierConfig.capability`,
> `inferCapability`, `POSITIONAL_VARIANTS`/`NAMED_VARIANTS`, and `DISCRETE_RANK`
> rank math. Test mapping: vitest suites `test/unit/reasoning-translate.test.ts`,
> `reasoning-capability.test.ts` (rewritten), `router-agents.test.ts`,
> `test/integration/reasoning-runtime.test.ts`.

## ADDED Requirements

### Requirement: Per-Tier Reasoning Control Is Optional

`reasoningControl` on a tier SHALL replace the removed `capability` field and all capability inference. A tier without `reasoningControl` MUST be valid, MUST dispatch with no reasoning patch (its static baseline serves), and MUST NOT bump. The silent unknown-variant degradation to `kind: "none"` MUST NOT exist.

#### Scenario: Control-free tier is valid and unpatched

- GIVEN a tier with a model but no `reasoningControl`
- WHEN config validates and a request dispatches
- THEN the tier is valid and the request carries no reasoning patch

#### Scenario: Model swap drops reasoning cleanly

- GIVEN a tier whose `reasoningControl` is removed after a model swap
- WHEN the new config loads
- THEN the tier serves without reasoning control and no error is raised

### Requirement: Channel Patch Mapping

`channel` MUST be one of `variant`, `reasoning.effort`, `thinking.budgetTokens`, applied via the existing patch/restore cycle: `variant` → `agentDef.variant`; `reasoning.effort` → `agentDef.options.reasoning_effort`; `thinking.budgetTokens` → `agentDef.options.budget_tokens`. Static baseline options (`tier.variant`, `tier.reasoning`, `tier.thinking`) MUST remain legal static agent-def inputs, overridden per request only by runtime patches, then restored.

#### Scenario: Each channel writes its target

- GIVEN one control per channel with a selected profile
- WHEN patches apply
- THEN `variant`, `reasoning_effort`, and `budget_tokens` receive their mapped native values respectively

#### Scenario: Baseline overridden then restored

- GIVEN a tier with static `thinking` options and a budget-channel control
- WHEN a patched request completes
- THEN the patch overrode the baseline for that request only and the baseline is restored

### Requirement: Ordered Native Levels Are User-Owned

`levels` MUST be the exact ordered list — ascending reasoning effort — of native values the tier's current model accepts; array order is the ONLY semantics and code MUST NOT interpret level names. String levels MUST be unique non-empty strings; budget levels MUST be unique ascending non-negative integers. Provider level renames MUST be fixable by a config edit alone.

#### Scenario: Provider rename is a config edit

- GIVEN a provider renames efforts from `[low, medium, high, max]` to `[low, high, max]`
- WHEN the operator rewrites the tier's `levels` and `profileMap` in `tiers.json`
- THEN dispatch works with no code change

#### Scenario: Order is the only semantics

- GIVEN levels `["a", "b", "c"]` in that order
- WHEN bumping occurs
- THEN effort ascends `a` → `b` → `c` by index, regardless of names

### Requirement: profileMap Bridges Registry to Native Levels

Each control's `profileMap` MUST map EVERY registered profile ID to a member of its `levels` (strict equality). Resolution MUST be `native = profileMap[selected]`, `levelIndex = levels.indexOf(native)`, patching by index clamped to the array bounds. The normalized four-grade vocabulary (`minimal|normal|elevated|max`), its provider-variant sets, and lossy rank math MUST NOT exist in source.

#### Scenario: Bridge resolves losslessly

- GIVEN three registered profiles mapped onto a three-level ladder
- WHEN each profile is selected
- THEN each maps to a distinct native level with no collapse

#### Scenario: Index patches clamp at bounds

- GIVEN an index at or beyond the last level
- WHEN a patch applies
- THEN the last level is used, never an out-of-range value
