import { describe, expect, it } from "vitest";
import { resolveReasoningProfile } from "../../src/reasoning/policy";

const signals = { prompt: "", description: "", tierName: "fast", isTrivial: false };

describe("reasoning profile policy", () => {
  it("keeps static mode as a hard no-op", () => {
    expect(resolveReasoningProfile({ mode: "static", profiles: ["p1"] }, "p1", signals)).toEqual({
      profile: null,
      overrideUnknown: false,
    });
  });

  it("prefers a registered manual override", () => {
    expect(
      resolveReasoningProfile(
        { mode: "manual", profiles: ["p1", "p2"], defaultProfile: "p1" },
        "p2",
        signals,
      ),
    ).toEqual({ profile: "p2", overrideUnknown: false });
  });

  it("falls back after an unknown override", () => {
    expect(
      resolveReasoningProfile(
        { mode: "manual", profiles: ["p1"], defaultProfile: "p1" },
        "old",
        signals,
      ),
    ).toEqual({ profile: "p1", overrideUnknown: true });
  });

  // Scenario: adaptive override beats selector (reasoning-profiles/spec.md:41-45)
  // A registered override wins over the adaptive selector regardless of signals.
  it("adaptive mode: registered override wins over selector", () => {
    const policy = {
      mode: "adaptive" as const,
      profiles: ["light", "standard", "deep"],
      defaultProfile: "light",
      adaptive: {
        rules: [{ keywords: ["refactor"], profile: "deep" }],
      },
    };
    // Override is "standard" but the selector would match "refactor" → "deep".
    // Override must win.
    const result = resolveReasoningProfile(policy, "standard", {
      ...signals,
      prompt: "refactor this module",
    });
    expect(result.profile).toBe("standard");
    expect(result.overrideUnknown).toBe(false);
  });

  it("adaptive mode: unknown override falls through to selector", () => {
    const policy = {
      mode: "adaptive" as const,
      profiles: ["light", "standard", "deep"],
      defaultProfile: "light",
      adaptive: {
        rules: [{ keywords: ["refactor"], profile: "deep" }],
      },
    };
    // Override is "unknown" (not registered) → selector runs, finds "deep".
    const result = resolveReasoningProfile(policy, "unknown", {
      ...signals,
      prompt: "refactor this module",
    });
    expect(result.profile).toBe("deep");
    expect(result.overrideUnknown).toBe(true);
  });
});
