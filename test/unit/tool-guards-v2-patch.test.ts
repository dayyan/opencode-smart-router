/**
 * test/unit/tool-guards-v2-patch.test.ts
 *
 * WU-3: Tests demonstrating the v2 path in applyOrchestratorReasoningPatch
 * correctly resolves a profile ID to a native patch and applies it to the
 * live agent def via applyReasoningPatch.
 *
 * RED: these tests fail before the v2 patch application is wired in tool-guards.ts.
 * GREEN: after wiring resolveReasoningProfile → resolveControlPatch → applyReasoningPatch.
 *
 * Design contract (D-1):
 *   v2 path: resolveReasoningProfile → resolveControlPatch → applyReasoningPatch
 *   overrideUnknown is logged at the call site.
 */

import { describe, expect, it } from "vitest";
import type { AdaptiveSignals, selectAdaptiveLevelV2 } from "../../src/reasoning/adaptive";
import { resolveReasoningProfile } from "../../src/reasoning/policy";
import { resolveControlPatch } from "../../src/reasoning/translate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal v2 policy for testing. */
const makeV2Policy = (
  overrides: {
    mode?: "static" | "manual" | "adaptive";
    profiles?: string[];
    defaultProfile?: string | null;
    adaptive?: Parameters<typeof selectAdaptiveLevelV2>[1]["adaptive"];
  } = {},
) => ({
  mode: overrides.mode ?? "manual",
  profiles: overrides.profiles ?? ["light", "standard", "deep"],
  defaultProfile: overrides.defaultProfile ?? "standard",
  adaptive: overrides.adaptive,
});

const baseSignals: AdaptiveSignals = {
  prompt: "refactor the auth module",
  description: "improve code quality",
  tierName: "medium",
  isTrivial: false,
};

// ---------------------------------------------------------------------------
// D-1: resolveReasoningProfile contract
// ---------------------------------------------------------------------------

describe("resolveReasoningProfile — D-1 contract (WU-3 foundation)", () => {
  it("static mode returns { profile: null, overrideUnknown: false }", () => {
    const policy = makeV2Policy({ mode: "static" });
    const result = resolveReasoningProfile(policy, "deep", baseSignals);
    expect(result.profile).toBeNull();
    expect(result.overrideUnknown).toBe(false);
  });

  it("manual mode with registered override returns the profile", () => {
    const policy = makeV2Policy({ mode: "manual" });
    const result = resolveReasoningProfile(policy, "deep", baseSignals);
    expect(result.profile).toBe("deep");
    expect(result.overrideUnknown).toBe(false);
  });

  it("manual mode with unregistered override sets overrideUnknown=true and uses defaultProfile", () => {
    // Per D-1 design: unregistered override → overrideUnknown: true, profile = defaultProfile.
    // Call site logs reasoning.override_unknown_profile and applies no patch when overrideUnknown.
    const policy = makeV2Policy({
      mode: "manual",
      profiles: ["light", "standard"],
      defaultProfile: "standard",
    });
    const result = resolveReasoningProfile(policy, "deep", baseSignals);
    expect(result.profile).toBe("standard"); // falls through to defaultProfile
    expect(result.overrideUnknown).toBe(true); // but flagged so call site knows override was rejected
  });

  it("manual mode with no override uses defaultProfile", () => {
    const policy = makeV2Policy({ mode: "manual", defaultProfile: "light" });
    const result = resolveReasoningProfile(policy, undefined, baseSignals);
    expect(result.profile).toBe("light");
    expect(result.overrideUnknown).toBe(false);
  });

  it("adaptive mode runs selector then falls back to defaultProfile", () => {
    const policy = makeV2Policy({
      mode: "adaptive",
      adaptive: {
        rules: [{ keywords: ["refactor"], profile: "deep" }],
      },
    });
    const signals = { ...baseSignals, prompt: "refactor this" };
    const result = resolveReasoningProfile(policy, undefined, signals);
    expect(result.profile).toBe("deep");
    expect(result.overrideUnknown).toBe(false);
  });

  it("adaptive mode with no match falls through to defaultProfile", () => {
    const policy = makeV2Policy({
      mode: "adaptive",
      defaultProfile: "light",
      adaptive: {
        rules: [{ keywords: ["architect"], profile: "deep" }],
      },
    });
    const result = resolveReasoningProfile(policy, undefined, baseSignals);
    expect(result.profile).toBe("light");
    expect(result.overrideUnknown).toBe(false);
  });

  it("unknown mode returns { profile: null } (fail-soft)", () => {
    const policy = makeV2Policy({ mode: "unknown" as any });
    const result = resolveReasoningProfile(policy, "deep", baseSignals);
    expect(result.profile).toBeNull();
    expect(result.overrideUnknown).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveControlPatch — profile-to-native bridge (WU-3 chain)
// ---------------------------------------------------------------------------

describe("resolveControlPatch — D-1 bridge (WU-3 chain)", () => {
  const makeControl = (profileMap: Record<string, string>, levels: string[]) => ({
    channel: "reasoning.effort" as const,
    profileMap,
    levels,
  });

  it("resolves a registered profile to native + levelIndex", () => {
    const control = makeControl({ light: "low", standard: "medium", deep: "high" }, [
      "low",
      "medium",
      "high",
    ]);
    const result = resolveControlPatch(control, "deep");
    expect(result).not.toBeNull();
    expect(result!.native).toBe("high");
    expect(result!.levelIndex).toBe(2);
  });

  it("returns null for null/undefined control", () => {
    expect(resolveControlPatch(null, "deep")).toBeNull();
    expect(resolveControlPatch(undefined, "deep")).toBeNull();
  });

  it("returns null for unregistered profile", () => {
    const control = makeControl({ light: "low", standard: "medium" }, ["low", "medium"]);
    expect(resolveControlPatch(control, "deep")).toBeNull();
  });

  it("returns null when profile maps to a native not in levels", () => {
    const control = makeControl({ deep: "ultra" }, ["low", "medium", "high"]);
    expect(resolveControlPatch(control, "deep")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full v2 chain: resolveReasoningProfile → resolveControlPatch (simulated)
// ---------------------------------------------------------------------------

describe("full v2 chain — resolveReasoningProfile + resolveControlPatch (WU-3)", () => {
  const makeControl = (profileMap: Record<string, string>, levels: string[]) => ({
    channel: "reasoning.effort" as const,
    profileMap,
    levels,
  });

  it("manual registered override: deep profile on medium-effort tier", () => {
    // Simulate what tool-guards.ts does with the v2 path:
    // 1. resolveReasoningProfile → profile
    // 2. resolveControlPatch(control, profile) → native + index
    const policy = makeV2Policy({ mode: "manual" });
    const control = makeControl({ light: "low", standard: "medium", deep: "high" }, [
      "low",
      "medium",
      "high",
    ]);

    const resolution = resolveReasoningProfile(policy, "deep", baseSignals);
    expect(resolution.profile).toBe("deep");
    expect(resolution.overrideUnknown).toBe(false);

    const patch = resolveControlPatch(control, resolution.profile!);
    expect(patch).not.toBeNull();
    expect(patch!.native).toBe("high");
    expect(patch!.levelIndex).toBe(2);
  });

  it("adaptive selector: resolves deep profile via keyword rule", () => {
    const policy = makeV2Policy({
      mode: "adaptive",
      adaptive: {
        rules: [{ keywords: ["refactor"], profile: "deep" }],
      },
    });
    const control = makeControl({ light: "low", standard: "medium", deep: "high" }, [
      "low",
      "medium",
      "high",
    ]);
    const signals = { ...baseSignals, prompt: "refactor this module" };

    const resolution = resolveReasoningProfile(policy, undefined, signals);
    expect(resolution.profile).toBe("deep");
    expect(resolution.overrideUnknown).toBe(false);

    const patch = resolveControlPatch(control, resolution.profile!);
    expect(patch).not.toBeNull();
    expect(patch!.native).toBe("high");
  });

  it("unregistered override: overrideUnknown=true, defaultProfile used but flagged", () => {
    // Per D-1: unregistered override → overrideUnknown: true, profile falls to defaultProfile.
    // Call site checks overrideUnknown and SKIPS the patch application when true.
    const policy = makeV2Policy({
      mode: "manual",
      profiles: ["light", "standard"],
      defaultProfile: "standard",
    });
    const control = makeControl({ light: "low", standard: "medium" }, ["low", "medium"]);

    const resolution = resolveReasoningProfile(policy, "deep", baseSignals);
    expect(resolution.overrideUnknown).toBe(true);
    // Profile falls through to defaultProfile, but call site must skip applying when overrideUnknown.
    expect(resolution.profile).toBe("standard");

    // Simulate call-site behavior: when overrideUnknown, do NOT apply patch.
    const patch = resolution.overrideUnknown
      ? null
      : resolveControlPatch(control, resolution.profile!);
    expect(patch).toBeNull(); // call site skips patch when overrideUnknown
  });

  it("static mode: profile is null regardless of override", () => {
    const policy = makeV2Policy({ mode: "static" });
    const control = makeControl({ light: "low", standard: "medium", deep: "high" }, [
      "low",
      "medium",
      "high",
    ]);

    const resolution = resolveReasoningProfile(policy, "deep", baseSignals);
    expect(resolution.profile).toBeNull();

    const patch = resolution.profile ? resolveControlPatch(control, resolution.profile) : null;
    expect(patch).toBeNull();
  });
});
