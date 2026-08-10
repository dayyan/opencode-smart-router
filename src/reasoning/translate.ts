// ---------------------------------------------------------------------------
// src/reasoning/translate.ts — Translate a normalized reasoning level into a
// provider-specific patch, routed by the capability's `field` channel.
//
// Pure function. No router state, no side effects, no IO. Policy resolution
// (static / manual / adaptive) lives in `policy.ts` (Phase 2); the surface
// detected by this module is purely "given a capability + a level, what patch
// would I emit if the policy asked for one?".
// ---------------------------------------------------------------------------

import type { ReasoningCapability, ReasoningLevel } from "./capability.js";

/**
 * Provider-specific reasoning patch to apply on top of the static agent def.
 * Exactly one of `variant` or `options` MAY be set per call (a given capability
 * routes through one channel only — see `cap.field`).
 *
 * `null` is the canonical "no-op / capability can't satisfy this level"
 * sentinel. Callers honor `surfaceLimits` to decide whether to emit a note.
 */
export type ResolvedReasoning = { variant?: string; options?: Record<string, unknown> } | null;

/**
 * Discrete input rank. Out-of-range ranks (e.g. from `Math.round`) are clamped
 * downstream via `Math.min(idx, len-1)` so this stays a trivial lookup.
 */
const DISCRETE_RANK: Record<ReasoningLevel, number> = {
  minimal: 0,
  normal: 1,
  elevated: 2,
  max: 3,
};

/**
 * Resolve a discrete capability's ladder index for a given reasoning level.
 * Duplicates the discrete rank formula from `translateLevel` so the index
 * is available independently of patch emission.
 */
export const resolveLevelIndex = (
  cap: ReasoningCapability,
  level: ReasoningLevel,
): number => {
  if (cap.kind !== "discrete") return 0;
  const target = DISCRETE_RANK[level];
  const rawIdx = Math.round((target / 3) * (cap.levels.length - 1));
  return Math.min(rawIdx, cap.levels.length - 1);
};

/**
 * Returns the ladder index for a named variant within a capability's levels.
 * For binary capabilities with no explicit levels array, returns 0 when
 * `variant` is undefined/absent (baseline) and 1 for elevated.
 * Returns `undefined` if the variant is not found in the ladder.
 */
export const levelIndexForVariant = (cap: ReasoningCapability, variant?: string): number | undefined => {
  if (cap.kind === "discrete" && cap.levels) {
    const idx = cap.levels.indexOf(variant ?? "");
    return idx >= 0 ? idx : undefined;
  }
  if (cap.kind === "binary") {
    return variant == null ? 0 : 1;
  }
  return 0;
};

/**
 * Returns the number of rungs in the capability ladder. Discrete caps return
 * `levels.length`; binary returns 2; none/budgeted return 0.
 */
export const capabilityLadderLength = (cap: ReasoningCapability): number => {
  if (cap.kind === "discrete" && cap.levels) return cap.levels.length;
  if (cap.kind === "binary") return 2;
  return 0;
};

/**
 * Translate a capability at a given ladder index (rather than a reasoning
 * level). Routes by `cap.field`:
 *
 *   - `variant`               → `{variant: <levels[idx]>}`  (discrete)
 *   - `reasoning.effort`      → `{options:{reasoning_effort:<levels[idx]>}}`
 *   - `undefined` (none/budgeted) → `null`
 *
 * Binary: idx >= 1 → elevated variant; idx === 0 → baseline or null.
 * Clamps `idx` to `levels.length - 1` for discrete.
 */
export const translateAtIndex = (
  cap: ReasoningCapability,
  idx: number,
): ResolvedReasoning => {
  if (cap.kind === "discrete" && cap.levels) {
    const clampedIdx = Math.min(idx, cap.levels.length - 1);
    const picked = cap.levels[clampedIdx];
    if (picked === undefined) return null;
    return cap.field === "variant"
      ? { variant: picked }
      : { options: { reasoning_effort: picked } };
  }
  if (cap.kind === "binary") {
    if (idx >= 1) return { variant: cap.elevated };
    return cap.baseline ? { variant: cap.baseline } : null;
  }
  // none / budgeted — no ladder, always null
  return null;
};

/**
 * Translate a normalized reasoning level into the provider-specific patch for
 * this capability. Routes output by `cap.field`:
 *
 *   - `field: "variant"`               → `ResolvedReasoning.variant`
 *   - `field: "reasoning.effort"`      → `ResolvedReasoning.options.reasoning_effort`
 *   - `field: "thinking.budgetTokens"` → `ResolvedReasoning.options.budget_tokens`
 *   - `kind: "none"`                   → `null` (never mutated; silent no-op)
 *
 * Discrete ladders clamp to the nearest available level via
 *   `Math.round((rank / 3) * (len - 1))`
 * so a 2-level ladder still produces a valid pickup for every normalized
 * input. `budgeted` falls back to `recommended["normal"]` when the requested
 * level has no entry, and returns `null` if even the fallback is absent.
 */
export const translateLevel = (
  cap: ReasoningCapability,
  level: ReasoningLevel,
): ResolvedReasoning => {
  switch (cap.kind) {
    case "none":
      return null;

    case "binary": {
      // minimal | normal → baseline (or null if no baseline declared)
      if (level === "elevated" || level === "max") {
        return { variant: cap.elevated };
      }
      return cap.baseline ? { variant: cap.baseline } : null;
    }

    case "discrete": {
      const target = DISCRETE_RANK[level];
      const rawIdx = Math.round((target / 3) * (cap.levels.length - 1));
      const idx = Math.min(rawIdx, cap.levels.length - 1);
      const picked = cap.levels[idx];
      if (picked === undefined) return null;

      return cap.field === "variant"
        ? { variant: picked }
        : { options: { reasoning_effort: picked } };
    }

    case "budgeted": {
      const tokens = cap.recommended[level] ?? cap.recommended.normal;
      if (tokens === undefined) return null;
      return { options: { budget_tokens: tokens } };
    }
  }
};
