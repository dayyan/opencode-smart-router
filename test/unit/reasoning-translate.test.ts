import { describe, expect, it } from "vitest";
import { patchAtIndex, resolveControlPatch } from "../../src/reasoning/translate";
import type { ReasoningControl } from "../../src/router/config.types";

const control: ReasoningControl = {
  channel: "reasoning.effort",
  levels: ["low", "high"],
  profileMap: { p1: "low", p2: "high" },
  maxBumps: 1,
};

const variantControl: ReasoningControl = {
  channel: "variant",
  levels: ["base", "think"],
  profileMap: { p1: "base", p2: "think" },
  maxBumps: 0,
};

const budgetControl: ReasoningControl = {
  channel: "thinking.budgetTokens",
  levels: [1024, 4096],
  profileMap: { p1: 1024, p2: 4096 },
  maxBumps: 0,
};

describe("reasoning control translation", () => {
  it("resolves a profile through its native map", () => {
    expect(resolveControlPatch(control, "p2")).toEqual({ native: "high", levelIndex: 1 });
    expect(resolveControlPatch(control, "unknown")).toBeNull();
  });

  it("clamps index patches to the control bounds", () => {
    expect(patchAtIndex(control, -1)).toEqual({ options: { reasoning_effort: "low" } });
    expect(patchAtIndex(control, 99)).toEqual({ options: { reasoning_effort: "high" } });
  });

  it("routes variant and budget channels", () => {
    expect(patchAtIndex(variantControl, 1)).toEqual({ variant: "think" });
    expect(resolveControlPatch(budgetControl, "p2")).toEqual({ native: 4096, levelIndex: 1 });
    expect(patchAtIndex(budgetControl, 0)).toEqual({ options: { budget_tokens: 1024 } });
  });

  it("handles absent controls and orphan mappings defensively", () => {
    expect(resolveControlPatch(null, "p1")).toBeNull();
    expect(patchAtIndex(undefined, 0)).toBeNull();
    expect(
      resolveControlPatch({ ...control, profileMap: { p1: "missing", p2: "high" } }, "p1"),
    ).toBeNull();
    expect(patchAtIndex({ ...control, channel: "unknown" as never }, 0)).toBeNull();
  });
});
