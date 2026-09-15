# Tier Fanout Specification

## Purpose

Bounded child-initiated parallel work whose workers are depth-2 children and terminal leaves.

## Requirements

### Requirement: Caller and Worker Policy

Fanout MUST admit only depth-1 medium/focused/heavy callers, excluding producers, graders, and fanout workers. Medium MUST request only fast; focused/heavy only fast/light/medium. Invalid calls and empty batches MUST return typed `rejected` without SDK calls.

#### Scenario: Eligibility matrix
- GIVEN each caller depth, tier, exclusion marker, and requested tier
- WHEN fanout runs
- THEN only permitted combinations proceed; all others reject before SDK calls

#### Scenario: Empty batch
- GIVEN an eligible caller
- WHEN items is empty
- THEN typed `rejected` returns without SDK calls

### Requirement: Parallel Caller-Parented Workers

Workers MUST use the depth-1 caller as parent (parentID = callerSid), their tier model/agent, and overlap within caps. Workers are depth-2 terminal leaves that cannot spawn further sessions. Native task/delegate nesting guards MUST remain unchanged.

#### Scenario: Overlapping children
- GIVEN two permitted workers
- WHEN neither prompt resolves
- THEN both prompts start in caller-parented depth-2 child sessions

#### Scenario: Hard depth ceiling
- GIVEN a depth-2 fanout worker
- WHEN it attempts fanout, task, or delegate
- THEN it is rejected before any SDK session creation and depth 3 never exists

### Requirement: Bounded Aggregation

Fanout MUST enforce worker and batch deadlines, returning one ordered `## [n] tier=<t> status=<s>` section per item with text or typed error; statuses MUST be completed/failed/timed_out/cancelled/rejected. Batch expiry MUST retain completed results and abort outstanding workers without delaying response beyond batchTimeoutMs.

#### Scenario: Partial timeout
- GIVEN one completed worker and one hung worker
- WHEN a deadline expires
- THEN completed text survives, the hung worker becomes timed_out, and abort is attempted

### Requirement: Cancellation and Cleanup

Caller cancellation MUST abort outstanding workers and return `""`. Abort waits MUST be bounded to 10s. Cleanup MUST release counters and tracking; failures MUST attempt abort, successes MUST persist without abort, and sessions MUST never be deleted.

#### Scenario: Terminal cleanup
- GIVEN success, failure, or caller cancellation
- WHEN cleanup executes
- THEN counters/tracking clear, only unsuccessful outstanding sessions receive bounded aborts, and cancellation returns empty text

### Requirement: Operational Visibility

Telemetry MUST expose timeouts, failed aborts, and unreconciled workers. Guidance MUST explain eligibility, parallel use, and bounded response without guaranteed termination; workers MUST receive no independent grading or per-attempt reasoning patches.

#### Scenario: Lingering worker
- GIVEN a timeout and failed abort
- WHEN the batch returns
- THEN telemetry exposes both failures and unreconciled work
