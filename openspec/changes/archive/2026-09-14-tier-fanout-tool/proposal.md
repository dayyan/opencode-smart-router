# Proposal: Child-Initiated Tier Fanout

## Intent (WHY)

Let tier children offload inexpensive work in parallel without higher-tier exploration costs or physical grandchildren. Plugin-owned sibling workers preserve nesting safeguards and bound response time.

## Scope (WHAT)

### In Scope
- Default-off `fanout` tool for depth-1 medium/focused/heavy callers; exclude producers, graders, and fanout workers. Medium may request fast; focused/heavy may request fast/light/medium.
- Root-parented parallel workers, typed outcomes, partial-result aggregation, deadlines, cancellation, concurrency caps, and a per-plugin circuit breaker.
- Validated configuration: unknown `maxConcurrentPerTier` keys reject load with a typed error; valid keys are the active preset intersected with fast/light/medium.
- Empty batches return structured `rejected` outcomes matching policy rejection, without SDK calls or silent empty success.
- Tier guidance, configuration documentation, and policy/lifecycle regression coverage.

### Out of Scope
- Native nesting or depth-setting changes; refactoring `delegate` or weakening existing guards.
- Independent worker DoD/grading, per-attempt reasoning patches, and process isolation.

## Capabilities

### New Capabilities
- `tier-fanout`: caller eligibility, worker policy, root parenting, bounded execution, aggregation, cancellation, and cleanup.
- `fanout-config`: defaults, strict validation, enablement, concurrency limits, and breaker behavior.

### Modified Capabilities
None. Existing main specs concern reasoning capabilities, which remain unchanged.

## Approach

Use flattened in-process batches from `exploration.md`; engineering details remain in `plans/044-tier-fanout-tool.md`, supplemented by the confirmed decisions above. Reuse delegate lifecycle patterns. Registration is load-time gated; disabling uses fresh configuration without restart. Breaker accounting follows the plan's timeout/failed-abort rule.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/plugin/fanout.ts` | New | Execution and containment store |
| `src/plugin/{context,runtime,types}.ts` | Modified | Wiring, registration, outcomes |
| `src/router/{config.types,config-validate,sessions}.ts` | Modified | Configuration and caller markers |
| `config/tiers/presets.json`, `tiers.json` | Modified | Guidance and generated tiers |
| `test/unit/`, `test/integration/nested-delegation-guard.test.ts` | Modified/New | Regression coverage |
| `README.md`, `docs/CONFIG_REFERENCE.md` | Modified | Operator guidance |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| SDK work outlives response | Medium | Caps, breaker, bounded aborts; document limitation |
| Parenting or cleanup races | Medium | Root-parent assertions, counter tests; never delete sessions |
| Runtime assumptions fail | Medium | Smoke-test child invocation/root parenting; stop on failure |

## Rollback Plan

Disable `fanout.enabled` immediately, then revert fanout changes and regenerate tiers. Preserve successful sessions and existing delegation guards.

## Dependencies

- Existing session ancestry and SDK lifecycle support; no new external dependency planned.

## Success Criteria

- [ ] Eligible callers run overlapping root-parented workers; prohibited calls make no SDK calls.
- [ ] Validation, empty-batch rejection, caps, deadlines, cancellation, breaker, and cleanup tests pass.
- [ ] No new baseline-relative failures; lint/build pass and coverage thresholds hold.
- [ ] Documentation states bounded response does not guarantee worker termination.
