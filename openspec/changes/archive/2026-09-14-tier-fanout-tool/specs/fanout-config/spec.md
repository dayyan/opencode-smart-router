# Fanout Configuration Specification

## Purpose

Control fanout admission and containment.

## Requirements

### Requirement: Defaults and Kill Switch

Defaults MUST be enabled=false, maxWorkersPerBatch=4, maxConcurrentGlobal=6, maxConcurrentPerTier={fast:4,light:2,medium:1}, workerTimeoutMs=120000, batchTimeoutMs=180000, breaker.failureThreshold=3, cooldownMs=60000. Registration MUST require load-time enablement; fresh disablement MUST reject without SDK calls.

#### Scenario: Disable without restart
- GIVEN fanout registered while enabled
- WHEN fresh configuration disables it
- THEN new calls reject without SDK calls

### Requirement: Strict Validation

Non-positive limits and batchTimeoutMs below workerTimeoutMs MUST fail validation. Explicit maxConcurrentPerTier keys outside active-preset ∩ {fast,light,medium} MUST reject configuration load with a typed error.

#### Scenario: Invalid configuration
- GIVEN each invalid limit, timeout ordering, or tier key
- WHEN configuration loads
- THEN validation rejects, with typed load errors for invalid keys

### Requirement: Concurrency Caps

Batch, global, and per-tier caps MUST reject excess work with typed `rejected`; concurrent batches MUST share plugin-instance limits.

#### Scenario: Exhausted capacity
- GIVEN any cap exhausted
- WHEN another worker requests admission
- THEN it rejects without creating a session

### Requirement: Circuit Breaker

Per-plugin breakers MUST open after failureThreshold consecutive batches containing timeout or failed abort; other outcomes MUST reset the streak. Open breakers MUST reject with `circuit_open`; cooldown MUST allow one half-open probe, closing on recovery or reopening on qualifying failure.

#### Scenario: Recovery probe
- GIVEN an open breaker
- WHEN cooldown expires and simultaneous batches arrive
- THEN exactly one probe proceeds; its outcome determines recovery or reopening
