// ---------------------------------------------------------------------------
// src/reasoning/capability.ts — Provider-specific reasoning patch channels.
//
// Pure channel types and patch mapping. NO side effects, NO file IO, NO router
// wiring.
// ---------------------------------------------------------------------------

/**
 * Output channel a control writes through. This discriminates between the
 * three provider APIs the router currently bridges:
 *
 *   - `"variant"`              → `agentDef.variant` (mimo / gpt-5.5 ladders, MiniMax named modes)
 *   - `"reasoning.effort"`     → `agentDef.options.reasoning_effort` (OpenAI-style effort option)
 *   - `"thinking.budgetTokens"`→ `agentDef.options.budget_tokens` (Anthropic-style token budget)
 *
 * Kept as a string literal union (not enum) so it round-trips through JSON
 * without ceremony.
 */
export type ReasoningControlChannel = "variant" | "reasoning.effort" | "thinking.budgetTokens";

/** Frozen list of all valid channels — consumed by the config validator. */
export const REASONING_CONTROL_CHANNELS: readonly ReasoningControlChannel[] = [
  "variant",
  "reasoning.effort",
  "thinking.budgetTokens",
] as const;

/**
 * Route a resolved native value through its channel to produce an agent-def
 * patch. Pure — no IO, no state.
 *
 * Per spec "Channel Patch Mapping":
 *   - `"variant"`             → `{ variant: <string> }`
 *   - `"reasoning.effort"`    → `{ options: { reasoning_effort: <string> } }`
 *   - `"thinking.budgetTokens"` → `{ options: { budget_tokens: <number> } }`
 */
export const channelPatch = (
  channel: ReasoningControlChannel,
  native: string | number,
): { variant?: string; options?: Record<string, unknown> } | null => {
  switch (channel) {
    case "variant":
      return { variant: native as string };
    case "reasoning.effort":
      return { options: { reasoning_effort: native as string } };
    case "thinking.budgetTokens":
      return { options: { budget_tokens: native as number } };
  }
};
