import { describe, expect, it } from "vitest";
import {
  channelPatch,
  inferCapability,
  type ReasoningControlChannel,
} from "../../src/reasoning/capability";
import type { TierConfig } from "../../src/router/config.types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseTier = (overrides: Partial<TierConfig> = {}): TierConfig => ({
  model: "test/model",
  description: "test tier",
  whenToUse: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// inferCapability
// ---------------------------------------------------------------------------

describe("inferCapability", () => {
  describe("none (no reasoning fields)", () => {
    it("returns { kind: 'none' } for a bare tier", () => {
      expect(inferCapability(baseTier())).toEqual({ kind: "none" });
    });

    it("returns { kind: 'none' } when variant is a free-form string", () => {
      // Inference is narrow on purpose — anything outside the positional /
      // named sets falls through to `none`. Configs that need a free-form
      // variant must declare capability explicitly (PR 3).
      expect(inferCapability(baseTier({ variant: "default" }))).toEqual({ kind: "none" });
    });

    it("returns { kind: 'none' } for a Claude-haiku-style tier with no reasoning fields", () => {
      expect(inferCapability(baseTier({ model: "anthropic/claude-haiku-4-5" }))).toEqual({
        kind: "none",
      });
    });
  });

  describe("discrete from reasoning.effort", () => {
    it("infers discrete / reasoning.effort with a fixed 3-level ladder", () => {
      expect(inferCapability(baseTier({ reasoning: { effort: "high", summary: "auto" } }))).toEqual(
        {
          kind: "discrete",
          field: "reasoning.effort",
          levels: ["low", "medium", "high"],
        },
      );
    });

    it("infers discrete / reasoning.effort even when only effort is set (summary ignored)", () => {
      expect(inferCapability(baseTier({ reasoning: { effort: "low" } }))).toEqual({
        kind: "discrete",
        field: "reasoning.effort",
        levels: ["low", "medium", "high"],
      });
    });
  });

  describe("budgeted from thinking.budgetTokens", () => {
    it("infers budgeted / thinking.budgetTokens with the default recommended ladder", () => {
      expect(inferCapability(baseTier({ thinking: { budgetTokens: 4096 } }))).toEqual({
        kind: "budgeted",
        field: "thinking.budgetTokens",
        recommended: { minimal: 1024, normal: 4096, elevated: 8192, max: 16000 },
      });
    });

    it("infers budgeted regardless of the actual token count value", () => {
      expect(inferCapability(baseTier({ thinking: { budgetTokens: 1 } })).kind).toBe("budgeted");
      expect(inferCapability(baseTier({ thinking: { budgetTokens: 100_000 } })).kind).toBe(
        "budgeted",
      );
    });
  });

  describe("discrete from positional variant", () => {
    it("infers discrete / variant for mimo's positional 'medium'", () => {
      // mimo-v2.5 uses `variant: "medium"` on `fast` — must come out as
      // discrete / variant / 3-level ladder so translateLevel can ladder up.
      expect(inferCapability(baseTier({ variant: "medium" }))).toEqual({
        kind: "discrete",
        field: "variant",
        levels: ["low", "medium", "high"],
      });
    });

    it("infers discrete / variant for 'low'", () => {
      expect(inferCapability(baseTier({ variant: "low" }))).toEqual({
        kind: "discrete",
        field: "variant",
        levels: ["low", "medium", "high"],
      });
    });

    it("infers discrete / variant for 'high'", () => {
      expect(inferCapability(baseTier({ variant: "high" }))).toEqual({
        kind: "discrete",
        field: "variant",
        levels: ["low", "medium", "high"],
      });
    });

    it("infers discrete / variant with a 4-level ladder for 'xhigh'", () => {
      // gpt-5.5-fast heavy uses variant: "xhigh" — must include the rung.
      expect(inferCapability(baseTier({ variant: "xhigh" }))).toEqual({
        kind: "discrete",
        field: "variant",
        levels: ["low", "medium", "high", "xhigh"],
      });
    });
  });

  describe("binary from named variant", () => {
    it("infers binary / variant (elevated='thinking') for the MiniMax named mode", () => {
      // MiniMax-M3 medium uses variant: "thinking" — must come out as
      // binary with elevated="thinking", no baseline.
      expect(inferCapability(baseTier({ variant: "thinking" }))).toEqual({
        kind: "binary",
        field: "variant",
        elevated: "thinking",
      });
    });

    it("infers binary / variant (elevated='max') for claude-opus 'max'", () => {
      expect(inferCapability(baseTier({ variant: "max" }))).toEqual({
        kind: "binary",
        field: "variant",
        elevated: "max",
      });
    });
  });

  describe("precedence (first match wins)", () => {
    it("reasoning.effort wins when both reasoning.effort and variant are set", () => {
      const cap = inferCapability(baseTier({ reasoning: { effort: "high" }, variant: "thinking" }));
      expect(cap).toEqual({
        kind: "discrete",
        field: "reasoning.effort",
        levels: ["low", "medium", "high"],
      });
    });

    it("reasoning.effort wins when reasoning.effort, thinking, and variant are all set", () => {
      const cap = inferCapability(
        baseTier({
          reasoning: { effort: "high" },
          thinking: { budgetTokens: 4096 },
          variant: "medium",
        }),
      );
      expect(cap.kind).toBe("discrete");
      expect(cap).toHaveProperty("field", "reasoning.effort");
    });

    it("thinking.budgetTokens wins over variant when reasoning.effort is absent", () => {
      const cap = inferCapability(
        baseTier({ thinking: { budgetTokens: 4096 }, variant: "medium" }),
      );
      expect(cap).toEqual({
        kind: "budgeted",
        field: "thinking.budgetTokens",
        recommended: { minimal: 1024, normal: 4096, elevated: 8192, max: 16000 },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// channelPatch — per spec: "Each channel writes its target"
// ---------------------------------------------------------------------------

describe("channelPatch", () => {
  describe("variant channel", () => {
    it("returns { variant: <value> } for the variant channel", () => {
      expect(channelPatch("variant", "low")).toEqual({ variant: "low" });
      expect(channelPatch("variant", "high")).toEqual({ variant: "high" });
      expect(channelPatch("variant", "thinking")).toEqual({ variant: "thinking" });
    });

    it("returns { variant: <value> } regardless of the string value", () => {
      expect(channelPatch("variant", "none")).toEqual({ variant: "none" });
      expect(channelPatch("variant", "max")).toEqual({ variant: "max" });
    });
  });

  describe("reasoning.effort channel", () => {
    it("returns { options: { reasoning_effort: <value> } } for the effort channel", () => {
      expect(channelPatch("reasoning.effort", "low")).toEqual({
        options: { reasoning_effort: "low" },
      });
      expect(channelPatch("reasoning.effort", "high")).toEqual({
        options: { reasoning_effort: "high" },
      });
    });
  });

  describe("thinking.budgetTokens channel", () => {
    it("returns { options: { budget_tokens: <value> } } for the budget channel", () => {
      expect(channelPatch("thinking.budgetTokens", 1024)).toEqual({
        options: { budget_tokens: 1024 },
      });
      expect(channelPatch("thinking.budgetTokens", 16384)).toEqual({
        options: { budget_tokens: 16384 },
      });
    });
  });
});

describe("ReasoningControlChannel", () => {
  it("accepts all three channel literals", () => {
    const channels: ReasoningControlChannel[] = [
      "variant",
      "reasoning.effort",
      "thinking.budgetTokens",
    ];
    expect(channels).toHaveLength(3);
  });
});
