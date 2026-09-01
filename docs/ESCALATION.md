# Layer 3: Quality escalation ladder

Wraps the authoritative `delegate` tool with a retry → escalate → honest give-up loop, bounded by attempt count and a cost ceiling.

> **Scope**: applies to the `delegate` tool (Option ii) only. The Option (i) verify-dispatch around the built-in `task` tool is advisory-grade and cannot retry a finished task call; it appends a forcing note but does not escalate.

## Loop per delegation

```
produce (current tier)
  → verify (Layer-2 gate)
  → recordAttempt (cost += tier.costRatio)
  → nextAction  →  accept | retry | escalate | give_up
                           ↓ on retry / escalate
               inject previous failure reasons into next producer prompt
               as "[router escalation] ..."
```

## `nextAction` decision order

Pure, provably terminating. Evaluated in order; first match wins.

| # | condition | action |
|---|-----------|--------|
| 1 | `verdict.pass === true` | **ACCEPT** |
| 2 | `totalAttempts >= maxTotalAttempts` | **GIVE_UP** ("max total attempts") |
| 3 | `cumulativeCost > firstAttemptCost × costMultiple` | **GIVE_UP** ("cost ceiling exceeded") |
| 4 | bump eligible (tier has `reasoningControl`, `maxBumps` remains, verdict cause = `verification_fail`) AND a higher native rung remains | **BUMP** reasoning within the same tier (does not consume the retry budget) |
| 5 | bump eligible but already at top rung | **ESCALATE** to next tier |
| 6 | `attemptsThisTier < maxAttemptsPerTier` | **RETRY** same tier |
| 7 | higher tier exists in ladder | **ESCALATE** |
| 8 | — | **GIVE_UP** ("no higher tier") |

Give-up checks (2, 3) precede retry/escalate, guaranteeing termination. ACCEPT is returned **only** when `pass === true`; a FAIL is never silently accepted. The BUMP branch (row 4) only runs when `canBumpReasoning` returns true and the tier still has rungs above the current level; row 5 covers the bumps-exhausted fall-through.

## Honest give-up

```
[router status: unmet] ... after N attempt(s) across M escalation(s)
(final tier <tier>; <reason>)
```

Returns the scrubbed best producer text and scrubbed failure reasons. Never a fake pass.

## Policy defaults (`buildEscalatePolicy`)

| field | default |
|-------|---------|
| `ladder` | `["fast","light","medium","focused","heavy"]` |
| `floorTier` | `null` |
| `maxAttemptsPerTier` | `1` |
| `maxTotalAttempts` | `4` |
| `costCeiling.multiple` | `4` |

`floorTier` pins the minimum starting tier, skipping cheap rungs for predictably-hard tasks.

When a controlled tier has remaining `reasoningControl.maxBumps`, a verification FAIL raises its native reasoning value before falling back to retries or tier escalation. Bumps do NOT count against `maxAttemptsPerTier`; that field counts retry attempts after native bumps are exhausted.

Worst-case produce attempts per tier = 1 (initial) + `reasoningControl.maxBumps` (bumps) + `maxAttemptsPerTier` (retries). Every attempt (bumps included) also counts toward `maxTotalAttempts`, which is the hard global bound.

## Cost ceiling worked example

```
ceiling = firstAttemptCostUnits × costCeiling.multiple
```

Multi-provider cost ratios: `fast=1 / light=2 / medium=5 / focused=10 / heavy=20`.

Starting at `fast` with `multiple: 4` → ceiling `= 1 × 4 = 4`:

```
attempt 1  fast    cumulative 1   (≤ 4, continue)
attempt 2  fast    cumulative 2   (≤ 4, continue)   ← retry same tier
attempt 3  light   cumulative 4   (≤ 4, continue)  ← escalates once
attempt 4  light   cumulative 6   (> 4, STOP)       ← cost ceiling exceeded
```

Effective shape: **[fast ×2, light ×2] → give-up**. `medium` and above are never reached from a `fast` start at `multiple: 4`.

To reach `medium`: raise `costCeiling.multiple` to `6` (`1×6=6` covers fast→light→medium), or set `floorTier: "medium"`. To reach `heavy`: `multiple: 20` or `floorTier: "focused"`.

See [ENFORCEMENT_PRESETS.md](./ENFORCEMENT_PRESETS.md) for per-mode configurations that pair `floorTier` and `multiple`.

## Safety net

An independent hard iteration cap derived from `ladder.length × maxAttemptsPerTier` sits beside the policy. Even a misconfigured policy cannot loop forever. Bump attempts are bounded by `maxTotalAttempts` (checked before the bump branch in `nextAction`), and the delegate loop's independent `safetyMax` cap still applies on top of that.

## Composition with provider failover

Provider `fallback` is **advisory only** — a text chain injected into the orchestrator's system prompt (`buildFallbackInstructions`). There is no runtime provider-switching code; it is orthogonal to this runtime ladder.

| event | outcome |
|-------|---------|
| Transport / API error during a producer attempt | Caught → empty artefact → counts as **one** failed ladder attempt. No provider swap. No double-counted attempt. |
| Verification FAIL | Quality escalation ladder (runtime). |

Precedence: API error ⇒ (advisory) provider failover; verification FAIL ⇒ (runtime) quality escalation.

## Layer-1 guard coverage

Escalated re-dispatches run in fresh plugin-created producer sessions that are registered so Layer-1 still guards them.
# Plan 041 migration

Reasoning bump limits are now owned by each tier's `reasoningControl.maxBumps`.
Remove the legacy global `enforcement.escalate.reasoningEscalation` block and
configure an explicit integer cap per controlled tier. The old key is rejected
with a pointer to the migration guidance in `docs/CONFIG_REFERENCE.md`.
