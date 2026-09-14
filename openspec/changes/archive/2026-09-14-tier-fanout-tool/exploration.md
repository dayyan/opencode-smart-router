## Exploration: tier-fanout-tool

### Current State
The plugin currently exposes the optional `delegate` tool from `src/plugin/runtime.ts:87-111`; its `ToolContext` supplies the caller session ID and abort signal. `src/plugin/delegate.ts` provides the established worker lifecycle: bounded session creation, producer registration, tier-model validation, prompt timeout, text extraction, cancellation, and fail-soft cleanup without deleting sessions.

Session ancestry is already tracked by `src/router/sessions.ts:159-321`, with `depth`, `parentOf`, `isDescendant`, producer registration, chat-message registration, and unregister cleanup. The `session.created` hook records parentage before the child can make tool calls (`src/plugin/hooks/session.ts:43-59`). Existing nested-delegation guards only reject `task` and `delegate` (`src/plugin/hooks/tool-guards.ts:70-82, 289-300`); `fanout` is not present and should remain outside those native-grandchild blocks.

The plugin context uses per-instance store factories (`src/plugin/context.ts:155-229`), and the config model currently has optional top-level blocks such as `experimental` and `reasoningPolicy` (`src/router/config.types.ts:275-294`). Section validation is orchestrated by `validateConfig` and extended through focused validators (`src/router/config-validate.ts:52-66`). Tier agents are registered as `mode: "subagent"` without extra permission configuration (`src/router/agents.ts:112-157`). The plan's cited anchors were spot-checked against the current tree; no significant citation drift was found. The working tree already contains unrelated changes in `package.json`, `plans/README.md`, and `pnpm-lock.yaml`; they are outside this exploration and must not be disturbed.

The selected safety shape is an in-process flattened batch: a depth-1 medium/focused/heavy child invokes one batch tool, while the plugin creates worker sessions as siblings parented to the root. This avoids physical grandchild sessions and gives the plugin ownership of worker caps, deadlines, cancellation, aggregation, and cleanup. The plan explicitly accepts that a bounded response does not guarantee termination of a stuck underlying SDK call.

### Affected Areas
- `src/router/config.types.ts` — add the optional fanout configuration and centralized defaults.
- `src/router/config-validate.ts` — validate positive limits, timeout ordering, and permitted concurrency-tier keys.
- `src/router/sessions.ts` — track producer and fanout-worker caller kinds while preserving existing method behavior.
- `src/plugin/fanout.ts` — implement the per-plugin concurrency/breaker store and flattened worker execution.
- `src/plugin/context.ts` — expose and initialize the fanout store per plugin instance.
- `src/plugin/runtime.ts` and `src/plugin/types.ts` — register the gated tool and define its argument/outcome types.
- `config/tiers/presets.json`, `README.md`, `docs/CONFIG_REFERENCE.md` — teach eligible tiers how to use the tool and document the bounded-response limitation.
- `test/unit/plugin-fanout.test.ts`, `test/unit/sessions.test.ts`, `test/unit/config-validate-sections.test.ts`, `test/integration/nested-delegation-guard.test.ts` — cover policy, lifecycle, validation, and guard interaction.

### Approaches
1. **Flattened in-process batch fan-out (selected Path B)** — the logical child caller invokes one tool; workers are created with `parentID` equal to the caller's root parent and are joined with per-worker and batch deadlines.
   - Pros: preserves the no-grandchild invariant; keeps worker ownership, caps, cancellation, aggregation, and cleanup inside the plugin; fits existing delegate/session-store patterns; supports parallelism without changing native OpenCode depth settings.
   - Cons: a timed-out SDK request may linger after the router returns; worker results have no independent DoD/grader in this phase; implementation must carefully prevent leaks and cross-batch counter races.
   - Effort: Medium

2. **Native nested delegation** — allow the depth-1 child to invoke the native `task`/nested-session path.
   - Pros: minimal new orchestration code and native task UX.
   - Cons: contradicts the existing guards and the verified runtime hang risk; foreground native tasks have no independent deadline; cancellation and cleanup would remain outside the plugin's control.
   - Effort: Low to implement, unacceptable risk

3. **Process-isolated worker backend** — run each fanout worker in a separately killable process.
   - Pros: provides a stronger termination boundary for hung SDK calls and isolates worker failures.
   - Cons: substantially larger architecture and lifecycle surface; requires IPC, process cleanup, and packaging decisions; explicitly deferred by the plan.
   - Effort: High

### Recommendation
Proceed with flattened in-process batch fan-out. It is the only approach that satisfies the no-grandchild safety requirement while retaining parallel lower-tier delegation and plugin-owned deadlines. Reuse the delegate lifecycle semantics in the new fanout module rather than modifying the existing delegate implementation or weakening `task`/`delegate` guards.

The proposal should make these remaining policy details explicit before implementation:
- whether “unknown” `maxConcurrentPerTier` keys are checked against the active preset, the fixed fanout policy tiers, or both;
- which worker failures count toward the breaker beyond timed-out workers and failed aborts, especially failed prompts and batch-level cancellation;
- whether the load-time gate is intentionally enable-on-restart while the fresh-config check only supports disabling without restart;
- how empty batches, malformed item prompts, and duplicate tier items are rejected and represented in aggregate output.

### Risks
- A timeout can bound the returned response without terminating an underlying SDK request, so unreconciled workers could accumulate and require telemetry/escalation to process isolation.
- Root-parent correctness is load-bearing: every worker creation must use `parentOf(callerSid)`, never the caller session ID.
- Cleanup must unregister and conditionally abort failed workers, never call `session.delete`, and preserve successful sessions.
- The existing baseline has known pre-existing typecheck/integration failures; verification must compare against the captured baseline rather than require a clean full-suite exit.
- The absent `openspec/config.yaml` means project-specific OpenSpec rules are unavailable; the existing `openspec/` tree and shared convention still establish the change path used here.

### Ready for Proposal
Yes — the architecture and affected surface are sufficiently understood for `sdd-propose`. The proposer should record the four policy clarifications above as explicit decisions or accepted defaults; no source-code drift blocker was found.
