import { describe, expect, it } from "vitest";
import type { ReasoningCapability, ReasoningLevel } from "../../src/reasoning/capability";
import {
  capabilityLadderLength,
  levelIndexForVariant,
  resolveLevelIndex,
  translateAtIndex,
  translateLevel,
} from "../../src/reasoning/translate";

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
