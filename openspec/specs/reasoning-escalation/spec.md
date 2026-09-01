# Delta for reasoning-escalation

> Source: plan 041 "Target design" (DECIDED 3, 4). Replaces the global
> `enforcement.escalate.reasoningEscalation` switch. Test mapping: vitest
> suites `test/unit/ladder.test.ts` (T-style property cases, exhaustion
> matrix) and `plugin-delegate.test.ts` (bump→bump→escalate flows).

## ADDED Requirements

### Requirement: maxBumps Is the Sole Bump Switch

Every `reasoningControl` MUST carry an integer `maxBumps` with `0 ≤ maxBumps ≤ levels.length − 1`. There MUST be no enable/bump boolean and no implicit default. `maxBumps: 0` MUST disable bumping; a tier without `reasoningControl` can never bump. Bumping is in play only when a profile is selected and `maxBumps > 0`; in every other case the ordinary retry/escalation policy applies.

#### Scenario: maxBumps 0 keeps ordinary policy

- GIVEN a tier with `reasoningControl` and `maxBumps: 0`
- WHEN a verification failure occurs
- THEN the ordinary retry/escalation policy applies and no bump happens

#### Scenario: Bump switch is required

- GIVEN a `reasoningControl` without `maxBumps`
- WHEN validation runs
- THEN it fails, with no implicit default applied

#### Scenario: No selection keeps ordinary policy

- GIVEN mode `static` on a control-bearing tier with `maxBumps: 1`
- WHEN a verification failure occurs
- THEN the ordinary retry/escalation policy applies (bumping never in play)

### Requirement: Bump Advances Exactly One Level Index

On a verification failure, a bump MUST be eligible iff: control exists AND a profile is selected AND `maxBumps > 0` AND current index < last index AND bumps used this tier < `maxBumps`. An eligible bump MUST move one level index up on the same tier and increment the tier's bump count. Effective bump room equals `min(maxBumps, levels.length − 1 − startIndex)`.

#### Scenario: Eligible bump ascends in place

- GIVEN a failed verification at `levels[1]` with bumps remaining
- WHEN the bump applies
- THEN the same tier retries at `levels[2]` and the bump count increments

#### Scenario: Start-at-top cannot bump

- GIVEN a selected profile mapping to the last level
- WHEN a verification failure occurs
- THEN no bump is possible because the top is reached

### Requirement: Bump Exhaustion Escalates Directly

When a verification failure on a tier whose bumping is in play finds bumps exhausted — cap reached or top level reached — the router MUST escalate the tier directly with NO additional same-level verification retry.

#### Scenario: Cap exhausted escalates without retry

- GIVEN `maxBumps: 2` and two bumps already used this tier
- WHEN another verification failure occurs
- THEN the tier escalates directly with no same-level retry

#### Scenario: Top reached escalates without retry

- GIVEN a verification failure at the last level with `maxBumps` remaining
- WHEN the failure is processed
- THEN the tier escalates directly (no level left to bump to)

### Requirement: Retryable Errors Never Consume Bumps

Retryable provider errors MUST follow the ordinary retry path and MUST NOT consume bumps. Bumped requests MUST still count toward `maxTotalAttempts`, whose semantics are unchanged.

#### Scenario: Retryable error leaves bump budget intact

- GIVEN a retryable provider error mid-tier with one bump used
- WHEN the ordinary retry runs
- THEN the bump count is unchanged
