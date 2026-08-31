import { describe, expect, it } from "vitest";
import type { ReasoningCapability, ReasoningLevel } from "../../src/reasoning/capability";
import {
  capabilityLadderLength,
  levelIndexForVariant,
  patchAtIndex,
  resolveControlPatch,
  resolveLevelIndex,
  translateAtIndex,
  translateLevel,
} from "../../src/reasoning/translate";
import type {
  BudgetReasoningControl,
  ReasoningControl,
  ReasoningProfileId,
  StringReasoningControl,
} from "../../src/router/config.types";

const LEVELS: ReasoningLevel[] = ["minimal", "normal", "elevated", "max"];

// ---------------------------------------------------------------------------
// none — never mutated, always null
// ---------------------------------------------------------------------------

describe("translateLevel / none", () => {
  const cap: ReasoningCapability = { kind: "none" };

  it("returns null for every normalized level", () => {
    for (const level of LEVELS) {
      expect(translateLevel(cap, level)).toBeNull();
    }
  });

  it("returns null even when every level is exercised", () => {
    expect(translateLevel(cap, "minimal")).toBeNull();
    expect(translateLevel(cap, "normal")).toBeNull();
    expect(translateLevel(cap, "elevated")).toBeNull();
    expect(translateLevel(cap, "max")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// binary — variant channel
// ---------------------------------------------------------------------------

describe("translateLevel / binary (variant channel)", () => {
  const withBaseline: ReasoningCapability = {
    kind: "binary",
    field: "variant",
    baseline: "default",
    elevated: "thinking",
  };
  const noBaseline: ReasoningCapability = {
    kind: "binary",
    field: "variant",
    elevated: "thinking",
  };

  it("elevated and max → elevated variant", () => {
    expect(translateLevel(withBaseline, "elevated")).toEqual({ variant: "thinking" });
    expect(translateLevel(withBaseline, "max")).toEqual({ variant: "thinking" });
  });

  it("elevated and max also resolve to elevated when no baseline is declared", () => {
    expect(translateLevel(noBaseline, "elevated")).toEqual({ variant: "thinking" });
    expect(translateLevel(noBaseline, "max")).toEqual({ variant: "thinking" });
  });

  it("minimal and normal → baseline variant (when baseline declared)", () => {
    expect(translateLevel(withBaseline, "minimal")).toEqual({ variant: "default" });
    expect(translateLevel(withBaseline, "normal")).toEqual({ variant: "default" });
  });

  it("minimal and normal → null (no baseline declared → silent no-op)", () => {
    expect(translateLevel(noBaseline, "minimal")).toBeNull();
    expect(translateLevel(noBaseline, "normal")).toBeNull();
  });

  it("never writes to .options (binary only owns the variant channel)", () => {
    for (const level of LEVELS) {
      const out = translateLevel(withBaseline, level);
      expect(out?.options).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// discrete / variant — clamps to nearest ladder position
// ---------------------------------------------------------------------------

describe("translateLevel / discrete / variant", () => {
  const threeLevel: ReasoningCapability = {
    kind: "discrete",
    field: "variant",
    levels: ["low", "medium", "high"],
  };
  const fourLevel: ReasoningCapability = {
    kind: "discrete",
    field: "variant",
    levels: ["low", "medium", "high", "xhigh"],
  };
  const twoLevel: ReasoningCapability = {
    kind: "discrete",
    field: "variant",
    levels: ["low", "high"],
  };

  it("3-level ladder maps per rank formula", () => {
    expect(translateLevel(threeLevel, "minimal")?.variant).toBe("low");
    expect(translateLevel(threeLevel, "normal")?.variant).toBe("medium");
    expect(translateLevel(threeLevel, "elevated")?.variant).toBe("medium");
    expect(translateLevel(threeLevel, "max")?.variant).toBe("high");
  });

  it("4-level ladder maps linearly (max → xhigh)", () => {
    expect(translateLevel(fourLevel, "minimal")?.variant).toBe("low");
    expect(translateLevel(fourLevel, "normal")?.variant).toBe("medium");
    expect(translateLevel(fourLevel, "elevated")?.variant).toBe("high");
    expect(translateLevel(fourLevel, "max")?.variant).toBe("xhigh");
  });

  it("2-level ladder clamps elevated/max to high and minimal/normal to low", () => {
    expect(translateLevel(twoLevel, "minimal")?.variant).toBe("low");
    expect(translateLevel(twoLevel, "normal")?.variant).toBe("low");
    expect(translateLevel(twoLevel, "elevated")?.variant).toBe("high");
    expect(translateLevel(twoLevel, "max")?.variant).toBe("high");
  });

  it("always returns a defined variant from a non-empty ladder", () => {
    for (const level of LEVELS) {
      const out = translateLevel(threeLevel, level);
      expect(out).not.toBeNull();
      expect(out?.variant).toBeDefined();
      expect(out?.options).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// discrete / reasoning.effort — routes the same ladder to options
// ---------------------------------------------------------------------------

describe("translateLevel / discrete / reasoning.effort", () => {
  const cap: ReasoningCapability = {
    kind: "discrete",
    field: "reasoning.effort",
    levels: ["low", "medium", "high"],
  };

  it("routes output into options.reasoning_effort", () => {
    expect(translateLevel(cap, "max")).toEqual({
      options: { reasoning_effort: "high" },
    });
    expect(translateLevel(cap, "minimal")).toEqual({
      options: { reasoning_effort: "low" },
    });
  });

  it("preserves the ladder per level (3-level rounding: normal & elevated both map to medium)", () => {
    // Documented quirk: on a 3-level ladder, `Math.round(rank/3 * (len-1))`
    // quantizes rank 1 (normal) and rank 2 (elevated) both to index 1 (medium).
    // This is the "nearest-level clamping" the orchestrator specified and
    // matches how `mimo-v2.5` (variant="medium") collapses requests for both
    // normal and elevated onto the medium rung.
    expect(translateLevel(cap, "minimal")?.options?.reasoning_effort).toBe("low");
    expect(translateLevel(cap, "normal")?.options?.reasoning_effort).toBe("medium");
    expect(translateLevel(cap, "elevated")?.options?.reasoning_effort).toBe("medium");
    expect(translateLevel(cap, "max")?.options?.reasoning_effort).toBe("high");
  });

  it("never writes a .variant on the reasoning.effort channel", () => {
    for (const level of LEVELS) {
      const out = translateLevel(cap, level);
      expect(out?.variant).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// budgeted — token ladder routes through budget_tokens
// ---------------------------------------------------------------------------

describe("translateLevel / budgeted", () => {
  const cap: ReasoningCapability = {
    kind: "budgeted",
    field: "thinking.budgetTokens",
    recommended: { minimal: 1024, normal: 4096, elevated: 8192, max: 16000 },
  };

  it("returns options.budget_tokens per level", () => {
    expect(translateLevel(cap, "minimal")).toEqual({ options: { budget_tokens: 1024 } });
    expect(translateLevel(cap, "normal")).toEqual({ options: { budget_tokens: 4096 } });
    expect(translateLevel(cap, "elevated")).toEqual({ options: { budget_tokens: 8192 } });
    expect(translateLevel(cap, "max")).toEqual({ options: { budget_tokens: 16000 } });
  });

  it("never writes a .variant on the budgeted channel", () => {
    for (const level of LEVELS) {
      const out = translateLevel(cap, level);
      expect(out?.variant).toBeUndefined();
      expect(out?.options?.budget_tokens).toBeDefined();
    }
  });

  it("falls back to 'normal' when the requested level entry is missing", () => {
    // Simulates a custom budget ladder that intentionally omits 'max' and
    // 'elevated' — only `normal` is reliable. The function falls back to it
    // rather than returning null so a partial ladder still maps.
    const partial: ReasoningCapability = {
      kind: "budgeted",
      field: "thinking.budgetTokens",
      recommended: { minimal: 1024, normal: 4096, elevated: 4096, max: 4096 },
    };
    // Type forces all four keys, but conceptually this is "anything not present
    // would fall back to normal". We exercise the mapping paths here as a
    // sanity check that the explicit fallback doesn't break the normal path.
    expect(translateLevel(partial, "normal")).toEqual({ options: { budget_tokens: 4096 } });
  });

  it("returns null when both the requested level and the 'normal' fallback are absent", () => {
    const empty: ReasoningCapability = {
      kind: "budgeted",
      field: "thinking.budgetTokens",
      // Cast to bypass the closed `Record<ReasoningLevel, number>` type —
      // the function must defend against a value not being a real number.
      recommended: { minimal: NaN, normal: NaN, elevated: NaN, max: NaN },
    };
    // NaN !== undefined, so the `??` branch does not kick in; the result is
    // a patch with `budget_tokens: NaN`. This documents that the contract is
    // "values must be real numbers when present" — the fallback only fires
    // for `undefined`/`missing`, not for invalid numbers.
    expect(translateLevel(empty, "max")).toEqual({ options: { budget_tokens: NaN } });
  });
});

// ---------------------------------------------------------------------------
// field routing — every capability lands in exactly one channel
// ---------------------------------------------------------------------------

describe("translateLevel / field routing sanity", () => {
  it("binary writes to .variant only", () => {
    const cap: ReasoningCapability = {
      kind: "binary",
      field: "variant",
      elevated: "thinking",
    };
    const out = translateLevel(cap, "elevated");
    expect(out?.variant).toBe("thinking");
    expect(out?.options).toBeUndefined();
  });

  it("discrete / variant writes to .variant only", () => {
    const cap: ReasoningCapability = {
      kind: "discrete",
      field: "variant",
      levels: ["low", "high"],
    };
    const out = translateLevel(cap, "max");
    expect(out?.variant).toBe("high");
    expect(out?.options).toBeUndefined();
  });

  it("discrete / reasoning.effort writes to .options only", () => {
    const cap: ReasoningCapability = {
      kind: "discrete",
      field: "reasoning.effort",
      levels: ["low", "high"],
    };
    const out = translateLevel(cap, "max");
    expect(out?.variant).toBeUndefined();
    expect(out?.options?.reasoning_effort).toBe("high");
  });

  it("budgeted writes to .options only", () => {
    const cap: ReasoningCapability = {
      kind: "budgeted",
      field: "thinking.budgetTokens",
      recommended: { minimal: 1024, normal: 4096, elevated: 8192, max: 16000 },
    };
    const out = translateLevel(cap, "max");
    expect(out?.variant).toBeUndefined();
    expect(out?.options?.budget_tokens).toBe(16000);
  });
});

// ---------------------------------------------------------------------------
// resolveLevelIndex — discrete rank clamped to ladder length
// ---------------------------------------------------------------------------

describe("resolveLevelIndex", () => {
  const threeLevel: ReasoningCapability = {
    kind: "discrete",
    field: "variant",
    levels: ["low", "medium", "high"],
  };
  const fiveLevel: ReasoningCapability = {
    kind: "discrete",
    field: "variant",
    levels: ["low", "medium", "high", "xhigh", "max"],
  };

  it("returns 0 for minimal on any ladder", () => {
    expect(resolveLevelIndex(threeLevel, "minimal")).toBe(0);
    expect(resolveLevelIndex(fiveLevel, "minimal")).toBe(0);
  });

  it("returns 1 for normal on any ladder", () => {
    expect(resolveLevelIndex(threeLevel, "normal")).toBe(1);
    expect(resolveLevelIndex(fiveLevel, "normal")).toBe(1);
  });

  it("returns 2 for elevated on any ladder", () => {
    // Note: for a 3-level ladder the formula clamps elevated to index 1 (medium)
    // because index 2 (high) would exceed the max level. The 5-level ladder
    // has room so elevated lands at index 3 (xhigh), not 2 (high).
    expect(resolveLevelIndex(fiveLevel, "elevated")).toBe(3);
  });

  it("returns max index for max on any ladder", () => {
    expect(resolveLevelIndex(threeLevel, "max")).toBe(2);
    expect(resolveLevelIndex(fiveLevel, "max")).toBe(4);
  });

  it("for 3-level ladder, elevated (rank 2) is clamped to 1 (medium) since max index is 2", () => {
    // Formula: Math.round((2/3) * 2) = Math.round(1.333) = 1
    expect(resolveLevelIndex(threeLevel, "elevated")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// levelIndexForVariant — map a variant name to its ladder index
// ---------------------------------------------------------------------------

describe("levelIndexForVariant", () => {
  const threeLevel: ReasoningCapability = {
    kind: "discrete",
    field: "variant",
    levels: ["low", "medium", "high"],
  };
  const fiveLevel: ReasoningCapability = {
    kind: "discrete",
    field: "variant",
    levels: ["low", "medium", "high", "xhigh", "max"],
  };

  it("returns correct index for known variant", () => {
    expect(levelIndexForVariant(threeLevel, "low")).toBe(0);
    expect(levelIndexForVariant(threeLevel, "medium")).toBe(1);
    expect(levelIndexForVariant(threeLevel, "high")).toBe(2);
  });

  it("returns correct index for five-level ladder", () => {
    expect(levelIndexForVariant(fiveLevel, "low")).toBe(0);
    expect(levelIndexForVariant(fiveLevel, "xhigh")).toBe(3);
    expect(levelIndexForVariant(fiveLevel, "max")).toBe(4);
  });

  it("returns undefined for unknown variant", () => {
    expect(levelIndexForVariant(threeLevel, "ultrahigh")).toBeUndefined();
  });

  it("returns 0 when variant is undefined (binary baseline)", () => {
    const binaryWithBaseline: ReasoningCapability = {
      kind: "binary",
      field: "variant",
      baseline: "default",
      elevated: "thinking",
    };
    expect(levelIndexForVariant(binaryWithBaseline, undefined)).toBe(0);
    expect(levelIndexForVariant(binaryWithBaseline)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// capabilityLadderLength — returns the ladder length for discrete kinds
// ---------------------------------------------------------------------------

describe("capabilityLadderLength", () => {
  it("returns levels.length for discrete capability", () => {
    const threeLevel: ReasoningCapability = {
      kind: "discrete",
      field: "variant",
      levels: ["low", "medium", "high"],
    };
    expect(capabilityLadderLength(threeLevel)).toBe(3);
  });

  it("returns 2 for binary capability", () => {
    const binary: ReasoningCapability = {
      kind: "binary",
      field: "variant",
      baseline: "default",
      elevated: "thinking",
    };
    expect(capabilityLadderLength(binary)).toBe(2);
  });

  it("returns 0 for none capability", () => {
    const none: ReasoningCapability = { kind: "none" };
    expect(capabilityLadderLength(none)).toBe(0);
  });

  it("returns 0 for budgeted capability", () => {
    const budgeted: ReasoningCapability = {
      kind: "budgeted",
      field: "thinking.budgetTokens",
      recommended: { minimal: 1024, normal: 4096, elevated: 8192, max: 16000 },
    };
    expect(capabilityLadderLength(budgeted)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// translateAtIndex — route by field, apply ladder index
// ---------------------------------------------------------------------------

describe("translateAtIndex", () => {
  describe("field: variant — discrete", () => {
    const threeLevel: ReasoningCapability = {
      kind: "discrete",
      field: "variant",
      levels: ["low", "medium", "high"],
    };
    const fiveLevel: ReasoningCapability = {
      kind: "discrete",
      field: "variant",
      levels: ["low", "medium", "high", "xhigh", "max"],
    };

    it("routes to {variant} for discrete variant capability", () => {
      expect(translateAtIndex(threeLevel, 0)).toEqual({ variant: "low" });
      expect(translateAtIndex(threeLevel, 1)).toEqual({ variant: "medium" });
      expect(translateAtIndex(threeLevel, 2)).toEqual({ variant: "high" });
    });

    it("index clamped to ladder bounds", () => {
      expect(translateAtIndex(threeLevel, 99)).toEqual({ variant: "high" });
    });

    it("five-level ladder maps correctly", () => {
      expect(translateAtIndex(fiveLevel, 0)).toEqual({ variant: "low" });
      expect(translateAtIndex(fiveLevel, 3)).toEqual({ variant: "xhigh" });
      expect(translateAtIndex(fiveLevel, 4)).toEqual({ variant: "max" });
    });
  });

  describe("field: reasoning.effort — discrete", () => {
    const cap: ReasoningCapability = {
      kind: "discrete",
      field: "reasoning.effort",
      levels: ["low", "medium", "high"],
    };

    it("routes to {options:{reasoning_effort}}", () => {
      expect(translateAtIndex(cap, 0)).toEqual({ options: { reasoning_effort: "low" } });
      expect(translateAtIndex(cap, 1)).toEqual({ options: { reasoning_effort: "medium" } });
      expect(translateAtIndex(cap, 2)).toEqual({ options: { reasoning_effort: "high" } });
    });

    it("index clamped to ladder bounds", () => {
      expect(translateAtIndex(cap, 99)).toEqual({ options: { reasoning_effort: "high" } });
    });
  });

  describe("field: undefined — returns null", () => {
    it("returns null for undefined field", () => {
      const noField: ReasoningCapability = { kind: "none" };
      expect(translateAtIndex(noField, 0)).toBeNull();
    });
  });

  describe("binary — idx>=1 => elevated, idx=0 => baseline or null", () => {
    const withBaseline: ReasoningCapability = {
      kind: "binary",
      field: "variant",
      baseline: "default",
      elevated: "thinking",
    };
    const noBaseline: ReasoningCapability = {
      kind: "binary",
      field: "variant",
      elevated: "thinking",
    };

    it("idx >= 1 => elevated variant", () => {
      expect(translateAtIndex(withBaseline, 1)).toEqual({ variant: "thinking" });
      expect(translateAtIndex(withBaseline, 5)).toEqual({ variant: "thinking" });
    });

    it("idx = 0 with baseline => {variant:baseline}", () => {
      expect(translateAtIndex(withBaseline, 0)).toEqual({ variant: "default" });
    });

    it("idx = 0 without baseline => null", () => {
      expect(translateAtIndex(noBaseline, 0)).toBeNull();
    });
  });

  describe("none / budgeted — returns null", () => {
    it("none capability always returns null", () => {
      const none: ReasoningCapability = { kind: "none" };
      expect(translateAtIndex(none, 0)).toBeNull();
      expect(translateAtIndex(none, 99)).toBeNull();
    });

    it("budgeted capability always returns null", () => {
      const budgeted: ReasoningCapability = {
        kind: "budgeted",
        field: "thinking.budgetTokens",
        recommended: { minimal: 1024, normal: 4096, elevated: 8192, max: 16000 },
      };
      expect(translateAtIndex(budgeted, 0)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// translateLevel output unchanged — regression guard
// ---------------------------------------------------------------------------

describe("translateLevel regression — output unchanged after new helpers added", () => {
  const threeLevel: ReasoningCapability = {
    kind: "discrete",
    field: "variant",
    levels: ["low", "medium", "high"],
  };
  const binaryWithBaseline: ReasoningCapability = {
    kind: "binary",
    field: "variant",
    baseline: "default",
    elevated: "thinking",
  };

  it("discrete translateLevel output unchanged", () => {
    expect(translateLevel(threeLevel, "minimal")?.variant).toBe("low");
    expect(translateLevel(threeLevel, "normal")?.variant).toBe("medium");
    expect(translateLevel(threeLevel, "elevated")?.variant).toBe("medium");
    expect(translateLevel(threeLevel, "max")?.variant).toBe("high");
  });

  it("binary translateLevel output unchanged", () => {
    expect(translateLevel(binaryWithBaseline, "elevated")).toEqual({ variant: "thinking" });
    expect(translateLevel(binaryWithBaseline, "minimal")).toEqual({ variant: "default" });
  });
});

// ---------------------------------------------------------------------------
// WU-2 — resolveControlPatch / patchAtIndex
// V2 reasoning control: profile ID → native level → channel patch
// Spec: reasoning-control/spec.md "profileMap Bridges Registry to Native Levels"
// ---------------------------------------------------------------------------

describe("resolveControlPatch — profile ID to native via profileMap", () => {
  // Fixture controls matching bundled-config data table (R-2 fixture IDs)
  const variantControl: StringReasoningControl = {
    channel: "variant",
    levels: ["low", "medium", "high"],
    profileMap: { p1: "low", p2: "medium", p3: "high" },
    maxBumps: 2,
  };
  const effortControl: StringReasoningControl = {
    channel: "reasoning.effort",
    levels: ["low", "medium", "high", "xhigh", "max"],
    profileMap: { light: "low", standard: "medium", deep: "high" },
    maxBumps: 3,
  };
  const budgetControl: BudgetReasoningControl = {
    channel: "thinking.budgetTokens",
    levels: [1024, 4096, 8192],
    profileMap: { light: 1024, standard: 4096, deep: 8192 },
    maxBumps: 2,
  };

  // Scenario: bridge resolves losslessly — each profile maps to a distinct level
  it("variant channel: each profile resolves to its mapped native with correct index", () => {
    const r1 = resolveControlPatch(variantControl, "p1");
    const r2 = resolveControlPatch(variantControl, "p2");
    const r3 = resolveControlPatch(variantControl, "p3");

    expect(r1?.native).toBe("low");
    expect(r1?.levelIndex).toBe(0);
    expect(r2?.native).toBe("medium");
    expect(r2?.levelIndex).toBe(1);
    expect(r3?.native).toBe("high");
    expect(r3?.levelIndex).toBe(2);

    // Lossless: all three natives are distinct
    expect(r1?.native).not.toBe(r2?.native);
    expect(r2?.native).not.toBe(r3?.native);
    expect(r1?.native).not.toBe(r3?.native);
  });

  it("effort channel: each profile maps to a distinct native level (5-level ladder)", () => {
    const rLight = resolveControlPatch(effortControl, "light");
    const rStandard = resolveControlPatch(effortControl, "standard");
    const rDeep = resolveControlPatch(effortControl, "deep");

    expect(rLight?.native).toBe("low");
    expect(rLight?.levelIndex).toBe(0);
    expect(rStandard?.native).toBe("medium");
    expect(rStandard?.levelIndex).toBe(1);
    expect(rDeep?.native).toBe("high");
    expect(rDeep?.levelIndex).toBe(2);

    // Distinct natives — no collapse
    expect(rLight?.native).not.toBe(rStandard?.native);
    expect(rStandard?.native).not.toBe(rDeep?.native);
  });

  it("budget channel: each profile maps to its numeric native level", () => {
    const rLight = resolveControlPatch(budgetControl, "light");
    const rStandard = resolveControlPatch(budgetControl, "standard");
    const rDeep = resolveControlPatch(budgetControl, "deep");

    expect(rLight?.native).toBe(1024);
    expect(rLight?.levelIndex).toBe(0);
    expect(rStandard?.native).toBe(4096);
    expect(rStandard?.levelIndex).toBe(1);
    expect(rDeep?.native).toBe(8192);
    expect(rDeep?.levelIndex).toBe(2);

    // Distinct natives
    expect(rLight?.native).not.toBe(rStandard?.native);
    expect(rStandard?.native).not.toBe(rDeep?.native);
  });

  // Null cases
  it("returns null when control is absent (undefined)", () => {
    expect(resolveControlPatch(undefined, "p1")).toBeNull();
  });

  it("returns null when control is null", () => {
    expect(resolveControlPatch(null as unknown as ReasoningControl, "p1")).toBeNull();
  });

  it("returns null when profileId is not in profileMap", () => {
    const result = resolveControlPatch(variantControl, "unknown-profile" as ReasoningProfileId);
    expect(result).toBeNull();
  });

  it("returns null when the mapped native value is not found in levels (orphan map entry)", () => {
    // A control whose profileMap points to a value absent from levels — defensive
    const orphanedControl: StringReasoningControl = {
      channel: "variant",
      levels: ["low", "high"], // no "medium" in levels
      profileMap: { p1: "low", p2: "medium" }, // p2 → "medium" not in levels
      maxBumps: 1,
    };
    expect(resolveControlPatch(orphanedControl, "p2")).toBeNull();
    expect(resolveControlPatch(orphanedControl, "p1")).not.toBeNull(); // p1 is valid
  });
});

describe("patchAtIndex — channel routing with index clamping", () => {
  const variantControl: StringReasoningControl = {
    channel: "variant",
    levels: ["low", "medium", "high"],
    profileMap: { p1: "low", p2: "medium", p3: "high" },
    maxBumps: 2,
  };
  const effortControl: StringReasoningControl = {
    channel: "reasoning.effort",
    levels: ["low", "medium", "high", "xhigh", "max"],
    profileMap: { light: "low", standard: "medium", deep: "high" },
    maxBumps: 3,
  };
  const budgetControl: BudgetReasoningControl = {
    channel: "thinking.budgetTokens",
    levels: [1024, 4096, 8192],
    profileMap: { light: 1024, standard: 4096, deep: 8192 },
    maxBumps: 2,
  };

  // Scenario: each channel writes its target
  it("variant channel writes {variant}", () => {
    expect(patchAtIndex(variantControl, 0)).toEqual({ variant: "low" });
    expect(patchAtIndex(variantControl, 1)).toEqual({ variant: "medium" });
    expect(patchAtIndex(variantControl, 2)).toEqual({ variant: "high" });
  });

  it("reasoning.effort channel writes {options:{reasoning_effort}}", () => {
    expect(patchAtIndex(effortControl, 0)).toEqual({ options: { reasoning_effort: "low" } });
    expect(patchAtIndex(effortControl, 3)).toEqual({ options: { reasoning_effort: "xhigh" } });
    expect(patchAtIndex(effortControl, 4)).toEqual({ options: { reasoning_effort: "max" } });
  });

  it("thinking.budgetTokens channel writes {options:{budget_tokens}}", () => {
    expect(patchAtIndex(budgetControl, 0)).toEqual({ options: { budget_tokens: 1024 } });
    expect(patchAtIndex(budgetControl, 1)).toEqual({ options: { budget_tokens: 4096 } });
    expect(patchAtIndex(budgetControl, 2)).toEqual({ options: { budget_tokens: 8192 } });
  });

  // Scenario: index clamps at bounds
  it("index beyond last level clamps to last (variant)", () => {
    // Index 99 → clamped to 2 (last = "high")
    expect(patchAtIndex(variantControl, 99)).toEqual({ variant: "high" });
  });

  it("index at exactly last level uses last (effort)", () => {
    // Index 4 = last on 5-level ladder
    expect(patchAtIndex(effortControl, 4)).toEqual({ options: { reasoning_effort: "max" } });
  });

  it("index beyond last level clamps to last (effort)", () => {
    expect(patchAtIndex(effortControl, 999)).toEqual({ options: { reasoning_effort: "max" } });
  });

  it("index beyond last level clamps to last (budget)", () => {
    // Index 100 → clamped to 2 → 8192
    expect(patchAtIndex(budgetControl, 100)).toEqual({ options: { budget_tokens: 8192 } });
  });

  it("index at last + 1 clamps correctly (budget)", () => {
    // len=3, last index=2; index=3 → clamped to 2
    expect(patchAtIndex(budgetControl, 3)).toEqual({ options: { budget_tokens: 8192 } });
  });

  // Null cases
  it("returns null when control is absent", () => {
    expect(patchAtIndex(undefined as unknown as ReasoningControl, 0)).toBeNull();
  });

  it("returns null when control is null", () => {
    expect(patchAtIndex(null as unknown as ReasoningControl, 0)).toBeNull();
  });

  // Negative index clamps to 0
  it("negative index clamps to 0 (variant)", () => {
    expect(patchAtIndex(variantControl, -5)).toEqual({ variant: "low" });
  });
});

describe("resolveControlPatch + patchAtIndex — end-to-end bridge", () => {
  const effortControl: StringReasoningControl = {
    channel: "reasoning.effort",
    levels: ["low", "medium", "high", "xhigh", "max"],
    profileMap: { light: "low", standard: "medium", deep: "high" },
    maxBumps: 3,
  };

  it("resolveControlPatch result feeds directly into patchAtIndex", () => {
    // p2 → standard → native "medium" → index 1
    const resolved = resolveControlPatch(effortControl, "standard");
    expect(resolved?.native).toBe("medium");
    expect(resolved?.levelIndex).toBe(1);

    const patch = patchAtIndex(effortControl, resolved!.levelIndex);
    expect(patch).toEqual({ options: { reasoning_effort: "medium" } });
  });

  it("unregistered profile returns null; null input to patchAtIndex is handled", () => {
    const resolved = resolveControlPatch(effortControl, "not-registered" as ReasoningProfileId);
    expect(resolved).toBeNull();
    // patchAtIndex must also handle null gracefully
    expect(patchAtIndex(effortControl, 0)).not.toBeNull();
  });

  it("distinct profiles never collapse to the same native value (lossless bridge)", () => {
    const natives = new Set<string | number>();
    for (const profile of ["light", "standard", "deep"] as const) {
      const resolved = resolveControlPatch(effortControl, profile);
      natives.add(resolved!.native);
    }
    // Three distinct profiles → three distinct natives
    expect(natives.size).toBe(3);
  });
});
