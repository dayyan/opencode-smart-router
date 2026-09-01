import { describe, expect, it } from "vitest";
import { channelPatch, REASONING_CONTROL_CHANNELS } from "../../src/reasoning/capability";

describe("reasoning control channels", () => {
  it("exposes the configured channels", () => {
    expect(REASONING_CONTROL_CHANNELS).toEqual([
      "variant",
      "reasoning.effort",
      "thinking.budgetTokens",
    ]);
  });

  it.each([
    ["variant", "thinking", { variant: "thinking" }],
    ["reasoning.effort", "high", { options: { reasoning_effort: "high" } }],
    ["thinking.budgetTokens", 4096, { options: { budget_tokens: 4096 } }],
  ])("maps %s to an agent patch", (channel, native, expected) => {
    expect(channelPatch(channel as never, native)).toEqual(expected);
  });
});
