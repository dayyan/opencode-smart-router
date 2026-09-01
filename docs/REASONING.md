# Reasoning Control

The router exposes a provider-agnostic way to control how much each subagent reasons before answering. It works through three layers:

1. A **per-tier reasoning control** that describes the provider-native values a tier can use.
2. A **profile registry** that gives users stable IDs for selecting those native values.
3. A **session-scoped override** set with the `/model-router-reasoning` command and applied at `task` dispatch time via `tool.execute.before`.

This is the Plan 041 v2 contract. Legacy `capability` and global `reasoningEscalation` keys are rejected during validation. Tiers without `reasoningControl` remain valid and keep their statically declared baseline.

**Cross-references:** [CONFIG_REFERENCE.md → `reasoningPolicy`](./CONFIG_REFERENCE.md#reasoningpolicy) · [Bundled controls](#bundled-controls) · [Policy modes](#policy-modes-reasoningpolicy) · [Adaptive mode](#adaptive-mode) · [`/model-router-reasoning` command](#model-router-reasoning-command) · [Migration](#backward-compatibility) · [`surfaceLimits`](#surfacelimits)

---

## Profile IDs and native levels

Profile IDs are user-owned strings registered in `reasoningPolicy.profiles`. Each controlled tier maps every registered ID to one value from its ordered, provider-native `reasoningControl.levels` ladder.

| Field | Meaning |
|---|---|---|
| `channel` | `variant`, `reasoning.effort`, or `thinking.budgetTokens`. |
| `levels` | Strictly ordered strings or non-negative numbers accepted by that channel. |
| `profileMap` | Exact registry-wide mapping from profile ID to a ladder value. |
| `maxBumps` | Maximum same-tier ladder advances after a verification failure; `0` disables bumping. |

`/model-router-reasoning <profile-id>` accepts only a registered profile ID. `off` clears the session override. The IDs and native values are intentionally not normalized across providers.

---

## Native translation

The translator resolves a profile ID through the tier's `reasoningControl.profileMap`, then emits a patch for the declared channel:

| Channel | Emitted patch |
|---|---|
| `variant` | `{ variant: <native value> }` |
| `reasoning.effort` | `{ options: { reasoning_effort: <native value> } }` |
| `thinking.budgetTokens` | `{ options: { budget_tokens: <native value> } }` |

`null` is the canonical "no-op" sentinel. Tiers without `reasoningControl` return `null` and retain their static baseline.

---

## Bundled controls

The bundled presets are authoritative. Controlled tiers declare `reasoningControl`; tiers without it are static-only.

### Control schema

Per tier (`TierConfig.reasoningControl`):

```ts
type ReasoningControl = {
  channel: "variant" | "reasoning.effort" | "thinking.budgetTokens";
  levels: string[] | number[];
  profileMap: Record<string, string | number>;
  maxBumps: number;
};
```

`profileMap` must contain exactly the registered profile IDs, and each mapped value must occur in `levels`.

---

## Policy modes (`reasoningPolicy`)

`reasoningPolicy.mode` controls when an override is applied:

| Mode | Behaviour | Use it for |
|---|---|---|
| `static` _(default when `reasoningPolicy` is absent)_ | Always returns `null` from the policy resolver. The agent definition remains at its declared baseline. | Static-only operation or configurations without reasoning controls. |
| `manual` | Resolves the session profile override, then the policy default, through the selected tier's `reasoningControl.profileMap`. A tier without a control returns `null`. | `/model-router-reasoning` driven overrides. |
| `adaptive` | Selects a registered profile from task signals, then resolves it through the selected tier's control. An explicit session override always wins. | Deterministic task-signal selection; see [Adaptive mode](#adaptive-mode). |

`surfaceLimits` defaults to `false`. See [below](#surfacelimits).

### Defaults shipped in `base.json`

```jsonc
{
  "reasoningPolicy": {
    "mode": "manual",
    "surfaceLimits": false
  }
}
```

Because `surfaceLimits` is `false`, the default behaviour is silent: a profile request on a tier without `reasoningControl` produces a confirmation in the chat but does not mutate the agent definition. Only an explicit `surfaceLimits: true` changes this.

To restore the pre-Plan-010 byte-identical behaviour, set `reasoningPolicy.mode` to `"static"`.

### Persisted policy-mode switching

The bundled default of `manual` mode is fine for most users, but operators who need to flip the runtime between override-driven and static behaviour without restarting OpenCode can persist a new mode through the router state overlay:

```bash
/model-router-reasoning mode manual   # enables per-session override flow (default)
/model-router-reasoning mode static   # disables it; tiers render at their declared baseline
/model-router-reasoning mode adaptive # opts in to the selector — see [Adaptive mode](#adaptive-mode)
```

The `mode` subcommand writes `reasoningMode` into the router state overlay via `saveReasoningMode()`, which is the same persistence path used by `/router enforce`. The next config refresh — the one the `command.execute.before` hook calls through `getFreshConfig()` — picks the new mode up and honors it on the next `task` dispatch. There is no per-session override for the policy mode; the value is global to the workspace.

### Adaptive mode

`adaptive` is a **deterministic, config-driven selector** (`src/reasoning/adaptive.ts`) — not an LLM inference and not a learned model. Given the same signals and policy, it returns the same decision every time. The selector is pure: no IO, no module state, no side effects, fully covered by `test/unit/adaptive-selector.test.ts`. Every decision is reproducible and operator-configurable.

#### Signal inputs (every dispatch)

The runtime extracts these from the Task-tool args at `tool.execute.before` (see `src/plugin/hooks.ts:154-163`) and threads them into `selectAdaptiveLevel()` as `AdaptiveSignals`:

| Signal | Source | Note |
|---|---|---|
| `prompt` | `args.prompt` from the built-in `task` tool | Normalised by the caller via `normalizeSignalText` (lowercase + collapse whitespace runs + trim). Keyword matching respects each rule's `match` mode (default `stem`); see [Keyword match modes](#keyword-match-modes). May be empty. |
| `description` | `args.description` from the built-in `task` tool | Same normalisation as `prompt`. May be empty. |
| `tierName` | `args.subagent_type` (e.g. `"medium"`, `"heavy"`) | Looked up against `reasoningPolicy.adaptive.tierDefaults`. |
| `isTrivial` | `ctx.sessionStore.isTrivial(sessionID)` | The dispatch-time trivial classification result. |

#### Decision order (first match wins)

The selector runs the steps below in order and stops at the first match. `null` at any step means "no patch" — the agent def is left at baseline.

1. `reasoningPolicy.adaptive` is absent → `null` (no adaptive config). This is the same effective behaviour as `static` mode for an unprepared config.
2. `signals.isTrivial === true` → `adaptive.trivialProfile` (or `null` if unset → no patch for trivial sessions).
3. `adaptive.tierDefaults[signals.tierName]` is set → that level.
4. `adaptive.rules` scanned in array order — first rule whose `excludeKeywords` do NOT match AND whose `keywords` match in `prompt` OR `description` wins. Matching respects the rule's `match` mode (default `"stem"`); see [Keyword match modes](#keyword-match-modes).
5. `adaptive.defaultProfile` (or `null` if unset → no patch).
6. Fall-through to `null` (no patch).

Every resolved profile is then passed through the tier's `reasoningControl`, so adaptive selection chooses a profile while translation emits the provider-native patch. A tier without a control resolves to `null`.

#### Precedence under adaptive mode

When `mode === "adaptive"` the resolver consults inputs in this order (highest first):

1. **Explicit session override** (`/model-router-reasoning <profile-id>` → `ctx.reasoningStore.get(sessionID)`) — **always wins**, regardless of selector output. Operators need certainty when they set an override manually.
2. `selectAdaptiveLevel(signals, policy)` result.
3. `policy.defaultProfile` as a safety net.
4. `null` (no patch).

This precedence is mirrored in the file header of `src/reasoning/policy.ts` and exercised by `test/unit/reasoning-policy.test.ts` (the `adaptive-mode delegates to selectAdaptiveLevel` describe block).

#### Config block

```jsonc
"reasoningPolicy": {
  "mode": "adaptive",
  "defaultProfile": "p2",
  "adaptive": {
    "trivialProfile": null,                                    // null → skip trivial sessions entirely
    "defaultProfile": "p2",                                 // catch-all for non-trivial tasks with no keyword match
      "rules": [
      { "keywords": ["refactor", "architecture", "security", "migration"], "profile": "p3" },
      { "keywords": ["debug", "diagnose", "investigate", "root cause"], "profile": "p3" },
      { "keywords": ["test", "fix", "patch"], "profile": "p2" }
    ],
    "tierProfileDefaults": { "fast": "p1" },                    // optional: pin a profile per tier
    "surfaceDecision": false                                  // debug-log every adaptive decision when true
  }
}
```

All fields are optional — a partial block is a valid config. `null` on `trivialProfile` / `defaultProfile` is a valid value (means "no patch"). Order matters in `rules`: the **first** rule whose keywords match wins, so high-precision rules MUST come before catch-alls. The shipped `config/tiers/base.json` carries the conservative defaults above with `mode: "manual"` so existing installs behave unchanged until operators opt in.

#### Keyword match modes

Each rule can declare a `match` strategy and a list of `excludeKeywords`. Both fields are optional; when omitted, `match` defaults to `"stem"` and `excludeKeywords` to `[]`.

```ts
type MatchMode = "word" | "stem" | "substring" | "regex";

interface AdaptiveKeywordRule {
  keywords: string[];
  profile: string;
  match?: MatchMode;          // default: "stem"
  excludeKeywords?: string[]; // same mode as `match`
}
```

| Mode | Behaviour | Example |
|---|---|---|
| `word` | Strict `\b<phrase>\b`. `debug` ≠ `debugging`. Use when you want to forbid inflections. | `match: "word"`, `keywords: ["debug"]` → matches `"debug the test"`, not `"debugging the test"`. |
| `stem` _(default)_ | Word-boundary at the start; suffix inflections allowed on the LAST token only. `debug` → `debugging`; `refactor` → `refactoring`. `latest` → ✗`test`; `prefix` → ✗`fix`. This is the only default that keeps inflections AND rejects cross-word false positives. | `keywords: ["debug"]` → matches both `"debug"` and `"debugging"`. |
| `substring` | Legacy `String.includes` behavior. Opt-in escape hatch for operators that explicitly want cross-word matches. | `match: "substring"`, `keywords: ["test"]` → matches `latest`, `contest`, etc. |
| `regex` | User-supplied pattern, compiled as-is. Power-user escape hatch. Fail-soft at runtime (selector returns `false` for invalid patterns); fail-fast at config load (`validateReasoningPolicy` rejects invalid `regex` rules before they ever reach dispatch). | `match: "regex"`, `keywords: ["^perf"]` → matches `"performance regression"`. |

`excludeKeywords` runs the same `match` mode as the rule's `keywords`. If any exclusion matches in `prompt` or `description`, the whole rule is skipped and the selector continues to the next rule. Use exclusions to disambiguate: a `format` rule can exclude on `refactor` so it does not fire for `format and refactor the module`.

The shipped `config/tiers/base.json` (as of Plan 018) demonstrates both new fields:

```jsonc
"rules": [
  {
    "keywords": ["format", "lint", "rename", "sort import", "bump version", "typo"],
    "profile": "p1",
    "excludeKeywords": ["refactor", "architect", "redesign"]
  },
  {
    "keywords": ["root cause", "rca", "security audit", "architecture redesign", "architect", "data migration"],
    "profile": "p4"
  },
  {
    "keywords": ["refactor", "security", "debug", "diagnose", "investigate", "performance", "profiling", "concurrency", "race condition", "optimize", "optimization", "memory leak", "bottleneck"],
    "profile": "p3"
  }
]
```

The first rule is a precision rule: it picks the configured low-cost profile for cosmetic tasks (format, lint, rename, sort import, bump version, typo) but explicitly opts out when the same prompt also mentions `refactor`, `architect`, or `redesign` — those rules can select a stronger registered profile instead. `mode: "manual"` remains the bundled default until operators opt in with `/model-router-reasoning mode adaptive`.

> **Stem mode is prefix-based, not linguistic stemming.** It covers suffix inflections of the *exact base* (`debug` → `debugging`, `refactor` → `refactoring`). Words with divergent bases (`optimize` vs `optimization`) must each be listed in the rule's `keywords`. Plan 018 ships both forms explicitly in the elevated rule above.

> **Known residual.** `word` and `stem` still match identifiers like `test_fixture` and `prefix_setup` because `_` is a `\w` character and `\b` is ASCII-only. Stripping code-fences before matching is a deeper change deferred to a future plan. Operators adding custom rules with those bare keywords should be aware.

#### What adaptive does NOT consider (yet)

The shipped selector is deliberately minimal. It does not consult any of:

- **Conversation history** — only the current task's `prompt` + `description`. Past turns, the user's prior preferences, and the conversation thread are not in scope.
- **Token usage** — no budget tracking, no cost ledger, no "you've used a lot so far" feedback. The `tierCaps` map in `base.json` is enforced separately by the `tool.execute.after` banner; it is not an adaptive signal.
- **Cross-session learning** — every dispatch is decided independently. There is no stored history of past decisions, no per-tier model, no analytics.
- **Tool-call counts in the same session** — the trivial classifier used at dispatch time is the only session-state signal read. The router does not remember what the previous dispatch decided.
- **The level chosen by previous dispatches in the same session** — adaptive is dispatch-by-dispatch, not cumulative. There is no escalation ladder that builds on prior calls.

A future plan can extend `AdaptiveSignals` and add new decision branches without touching the runtime call site (the selector is pure). Today, if you need any of the above signals, switch to `manual` mode and use `/model-router-reasoning <profile-id>` directly per dispatch.

#### Forcing manual control (workarounds)

There are three ways to override the selector — for a single dispatch, for one tier, or for the whole workspace:

- **Per-session, single dispatch.** Set an override before dispatching: `/model-router-reasoning p3`. The override wins for the next `task` call in this session; clear with `/model-router-reasoning off`. The override applies to all tiers in that session, not just one.
- **Per-tier pinning.** Add the tier name to `reasoningPolicy.adaptive.tierDefaults` — that tier's profile is decided by the table, not by keywords or the trivial classifier. Useful for pinning `@fast` to `p1` (no selector overhead on cheap lookups) or `@heavy` to `p3` (always reason harder on heavy dispatch).
- **Disable adaptive globally.** `/model-router-reasoning mode static` — restores pre-Plan-015 byte-identical behaviour (no patches ever). Or `/model-router-reasoning mode manual` — keeps the per-session override surface but disables automatic selection. Both persist through `saveReasoningMode()`.

#### Opt-in observability

Set `reasoningPolicy.adaptive.surfaceDecision` to `true` to emit `log.debug({ event: "reasoning.adaptive_selected", session, tier, level, reason })` on every dispatch under `adaptive` mode. `reason` is a short machine-friendly string (`"trivial"`, `"tier default: heavy"`, `"keyword match: refactor"`, `"default level"`, `"no adaptive config"`) so operators can correlate what each dispatch decided without re-running the selector. Off by default — leave it `false` for production to avoid log noise. Independent from `reasoningPolicy.surfaceLimits`, which controls the `reasoning.patch_applied` / `reasoning.patch_unsupported` events emitted at `src/plugin/hooks.ts:170-188`.

---

## `/model-router-reasoning` command

The `/model-router-reasoning` command is the user-facing entry point. It has two distinct surfaces, separated by the `mode` subcommand:

- **Profile overrides** (`<registered-profile-id>` / `off`) set a **session-scoped** override on `ctx.reasoningStore`. The override applies to the next `task` dispatch in this session only and is cleared by `off`.
- **Mode switching** (`mode static` / `mode manual` / `mode adaptive`) **persists** a new policy-mode value through the router state overlay (`saveReasoningMode`). The change is global to the workspace and survives restarts — it is NOT session-scoped. `mode adaptive` opts in to the selector described under [Adaptive mode](#adaptive-mode); `mode static` and `mode manual` preserve their pre-Plan-015 semantics.

### Usage

| Form | Effect |
|---|---|
| `/model-router-reasoning` _(no args)_ | Print policy mode + per-tier reasoning-control descriptions. |
| `/model-router-reasoning p1` | Set session override to registered profile `p1`. |
| `/model-router-reasoning off` | Clear the session override. |
| `/model-router-reasoning mode` | Print the current persisted policy mode + usage. |
| `/model-router-reasoning mode static` | **Persist** `mode: "static"` to the state overlay; takes effect on the next config refresh. |
| `/model-router-reasoning mode manual` | **Persist** `mode: "manual"` to the state overlay; takes effect on the next config refresh. |
| `/model-router-reasoning mode adaptive` | **Persist** `mode: "adaptive"` to the state overlay; the selector described under [Adaptive mode](#adaptive-mode) takes effect on the next config refresh. Per-session overrides still win over the selector. |
| `/model-router-reasoning foo` | Reject an unregistered profile. Run `/model-router-reasoning` to inspect the registered profiles. |

The level override applies to the **next `task` dispatch in this session only**. The runtime hooks restore the baseline tier config in `tool.execute.after`, so a session override does not leak to subsequent dispatches or to other sessions. The persisted mode, by contrast, applies to every dispatch that loads the config from that point on — until another `mode` call (or a manual edit to the state file) changes it again.

### Example output (`/model-router-reasoning p2`)

```
Reasoning override set to **p2** for this session.

Per-tier behaviour:
- @fast: variant = 'high'.
- @medium: variant = 'thinking'.
- @heavy: options = {"reasoning_effort":"high"}.

Takes effect on the next `task` dispatch in this session.
```

### Example output (`/model-router-reasoning mode manual`)

```
Reasoning policy mode set to **manual** and persisted.

Per-session overrides are enabled — `/model-router-reasoning <profile-id>` will take effect on the next task dispatch.

Takes effect on the next config refresh.
```

### How the override is applied

```
/model-router-reasoning p3
  -> command.execute.before (sessionID threaded through runtime)
  -> reasoningStore.set(sessionID, "p3")

Task(subagent_type="medium")
  -> tool.execute.before
  -> resolveReasoningProfile(v2Policy, profile, signals)
  -> applyReasoningPatch(liveAgent, resolved)
  -> task spawns child with patched agent config
  -> tool.execute.after restores baseline tier config
  -> same-tier overlap is skipped, not double-patched (see Same-tier in-flight guard below)
  -> runtime emits a log.debug event when surfaceLimits=true (see surfaceLimits)
```

`tool.execute.after` always restores from the `structuredClone` baseline captured at `handleConfig` time, so concurrent unrelated dispatches on different tiers never see each other's state.

### Same-tier in-flight guard

The reasoning store tracks one owner per tier (the sessionID currently holding the patch lock for that tier). A second same-tier dispatch observes `acquireTierOwner` returning `false` and **skips the patch** rather than overwriting an in-flight one. The skipped dispatch emits the debug event `reasoning.patch_skipped_concurrent` with the current owner, so the reason the patch was suppressed is observable without leaking into the chat. The after-hook releases ownership only when the current session is still the owner, so a foreign after-hook cannot drop another session's lock.

The plugin-owned `delegate` tool participates in the same protocol: each invocation uses a `delegate:<producerSid>` owner key (deliberately distinct from any hook-path session id so a delegate and a concurrent hook patch, or two parallel delegates, on the same tier genuinely conflict). The delegate acquires before snapshotting + patching, skips the patch — emitting `reasoning.patch_skipped_concurrent` — when contended, and releases every acquired tier in its outer `finally` so the attempt runs unpatched rather than racing an in-flight baseline.

---

## Backward compatibility

Plan 010 is fully backward-compatible with every config shipped before it.

| Pre-Plan-010 config | Post-Plan-010 behaviour |
|---|---|
| No `reasoningPolicy` block | Resolves to `static` mode. `resolveReasoningOverride` returns `null` regardless of any session override. Agent output is **byte-identical** to pre-Plan-010. |
| No `reasoningControl` on a tier | Valid static-only tier. The router does not infer a control from `variant`, `reasoning.effort`, or `thinking.budgetTokens`. |
| Legacy `capability` or `reasoningEscalation` key | Rejected during validation with migration guidance; no compatibility inference is performed. |

The default in the **bundled** `base.json` is now `manual` mode (so `/model-router-reasoning` works out of the box). User-supplied `global` / `local` tiers.json layers can override it back to `static` to keep pre-Plan-010 behaviour verbatim.

There is no inference from static provider fields. If a tier needs runtime reasoning control, declare its complete `reasoningControl` explicitly.

---

## `surfaceLimits`

`surfaceLimits` is an opt-in presentation flag. It does NOT change which patches are emitted — surfacing is purely a presentation concern owned by the `/model-router-reasoning` command and the runtime log layer.

| Value | Effect |
|---|---|
| `false` _(bundled default)_ | Silent no-op when a tier has no control or a requested profile cannot be applied. |
| `true` | When a tier has no usable reasoning control, the `/model-router-reasoning` output flags it. The runtime emits `log.debug` events keyed by `event`: `reasoning.patch_applied`, `reasoning.patch_unsupported`, and `reasoning.patch_skipped_concurrent`. |

Surfacing is observability, not a user-facing message: the debug events never appear in the chat, they only show up in the plugin log. There is no advisory "pending note" path — that plumbing was removed in Plan 014 because nothing consumed it.

Set `surfaceLimits: true` while you are triaging a new tier or a new override; leave it `false` for production.

---

## Native ladder behavior

Each tier's `levels` array is ordered in provider-native values. Profile IDs map directly to those values; there is no cross-provider rank normalization or ladder-collapse rule.

### Other limitations

- A controlled tier's `profileMap` must cover the complete registry, even when several profile IDs intentionally map to the same native value.
- The bundled default mode is `manual`, which means `/model-router-reasoning` works out of the box. Set `reasoningPolicy.mode` to `static` to restore the pre-Plan-010 byte-identical behaviour.
- The `adaptive` mode is **available as an opt-in**. The bundled `config/tiers/base.json` ships a conservative profile-based adaptive block and keeps `mode: "manual"` as the default. The selector is intentionally minimal — no history, no token usage, no cross-session learning.

---

## Verification

## Plan 041 migration note

The v2 reasoning contract is breaking. Replace each tier's removed `capability`
object with a `reasoningControl` containing ordered native `levels`, an exact
`profileMap` for every registered profile, and an explicit `maxBumps` value.
Replace the removed global `enforcement.escalate.reasoningEscalation` block with
per-tier `reasoningControl.maxBumps`. Invalid legacy keys are rejected and the
validator points to this migration guidance; there is no compatibility
inference for the old shapes.

Per [plans/010-adaptive-reasoning.md](../../plans/010-adaptive-reasoning.md) (infrastructure) and [plans/015-adaptive-reasoning-engine.md](../../plans/015-adaptive-reasoning-engine.md) (selector engine):

| Layer | Tests |
|---|---|
| Unit — control | `test/unit/reasoning-capability.test.ts` — native channels and control-free tiers. |
| Unit — translation | `test/unit/reasoning-translate.test.ts` — profile-to-native resolution and channel routing. |
| Unit — adaptive matcher | `test/unit/adaptive-match.test.ts` — `normalizeSignalText`; the four `match` modes (`word` / `stem` / `substring` / `regex`); stem cross-word rejection (`latest`✗`test`, `prefix`✗`fix`); inflection (`debug`→`debugging`); invalid regex fail-soft; memoization smoke. |
| Unit — adaptive selector | `test/unit/adaptive-selector.test.ts` — every `selectAdaptiveLevel` branch: no-config → `null`; trivial; tierDefaults; keyword priority (first match wins); case-insensitivity; description-only match; default fallback; empty inputs; deterministic. As of Plan 018: cross-word regression (`test`✗`latest`, `fix`✗`prefix`); inflection via `stem` (`debug`→`debugging`); strict `word` mode rejecting inflections; `excludeKeywords` skip; phrase whitespace; richer reason (`rule[i] "<kw>" (<mode>) in <source>`); backward-compat for match-less rules. |
| Unit — adaptive policy validation | `test/unit/config-validate-sections.test.ts` — `validateReasoningPolicy` happy/error paths; rejects empty `keywords`, bad `profile`, bad `match` mode, invalid regex; accepts `null` profiles. |
| Unit — policy | `test/unit/reasoning-policy.test.ts` — `static` ALWAYS null; `manual`+override applies; `adaptive` precedence (session override wins → selector → `defaultProfile` → null); `surfaceLimits` does NOT alter resolved patch. |
| Unit — agent wiring | `test/unit/router-agents.test.ts` — `applyReasoningPatch` + `restoreAgentBaseline` round-trip; control-free tiers are never mutated; `resolveReasoningOverride` accepts adaptive signals. |
| Unit — command | `test/unit/router-commands.test.ts` — `/model-router-reasoning` validates registered profiles, persists `mode static|manual|adaptive`, and sets/clears the store. |
| Unit — hooks | `test/unit/plugin-hooks.test.ts` — `handleConfig` captures baseline; `tool.execute.before/after` patch/restore; under `mode: "adaptive"`, threads `AdaptiveSignals` into the resolver and emits `reasoning.adaptive_selected` when `surfaceDecision: true`. |

Run:

```bash
pnpm test -- adaptive-match adaptive-selector config-validate-sections reasoning router-agents router-commands plugin-hooks
```
