// ---------------------------------------------------------------------------
// src/reasoning/translate.ts — Translate a normalized reasoning level into a
// provider-specific patch, routed by the capability's `field` channel.
//
// Pure function. No router state, no side effects, no IO. Policy resolution
// (static / manual / adaptive) lives in `policy.ts` (Phase 2); the surface
// detected by this module is purely "given a capability + a level, what patch
// would I emit if the policy asked for one?".
//
// WU-2 (Plan 041): Two additional exports layer the v2 profile→native bridge:
//   resolveControlPatch(control, profileId) — resolves profile to {native, levelIndex}
//   patchAtIndex(control, levelIndex)        — applies clamped index to produce channel patch
// ---------------------------------------------------------------------------

import type { ReasoningCapability, ReasoningLevel } from "./capability.js";
import {
  channelPatch,
  type ReasoningControlChannel,
} from "./capability.js";
import type {
  ReasoningControl,
  StringReasoningControl,
  BudgetReasoningControl,
  ReasoningProfileId,
} from "../router/config.types.js";

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
export const resolveLevelIndex = (cap: ReasoningCapability, level: ReasoningLevel): number => {
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
export const levelIndexForVariant = (
  cap: ReasoningCapability,
  variant?: string,
): number | undefined => {
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
export const translateAtIndex = (cap: ReasoningCapability, idx: number): ResolvedReasoning => {
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

// ---------------------------------------------------------------------------
// WU-2 — V2 profile→native bridge (Plan 041)
// ---------------------------------------------------------------------------

/**
 * Return type for `resolveControlPatch`: a resolved native value and its
 * zero-based ladder index, derived entirely from the control's profileMap.
 */
export interface ResolvedControlPatch {
  native: string | number;
  levelIndex: number;
}

/**
 * Resolve a registered profile ID to its native level and ladder index
 * through the control's `profileMap`.
 *
 * Returns `null` when:
 * - `control` is null/undefined (tier has no reasoning control)
 * - `profileId` is not present in `control.profileMap`
 * - the mapped native value is not found in `control.levels` (orphan entry)
 *
 * Per spec "profileMap Bridges Registry to Native Levels":
 * `native = profileMap[selected]`, `levelIndex = levels.indexOf(native)`.
 */
export const resolveControlPatch = (
  control: ReasoningControl | undefined | null,
  profileId: ReasoningProfileId,
): ResolvedControlPatch | null => {
  if (control == null) return null;

  const native = control.profileMap[profileId];
  if (native === undefined) return null;

  // Defensive: if the mapped native is somehow not in levels, treat as null.
  // This guards against stale map entries if a tier config is misconfigured.
  const levelIndex = control.levels.indexOf(native as never);
  if (levelIndex < 0) return null;

  return { native, levelIndex };
};

/**
 * Apply a clamped ladder index to a reasoning control, producing a channel
 * patch via `channelPatch`.
 *
 * Clamps `levelIndex` to `[0, levels.length - 1]` so out-of-range indices
 * (e.g. from a mis-seeded LadderState or an upstream error) never produce
 * an out-of-bounds array access.
 *
 * Returns `null` when `control` is null/undefined.
 *
 * Per spec "Index patches clamp at bounds":
 * `patched native = levels[Math.min(levelIndex, levels.length - 1)]`.
 */
export const patchAtIndex = (
  control: ReasoningControl | undefined | null,
  levelIndex: number,
): ResolvedReasoning => {
  if (control == null) return null;

  // String-level control
  if (control.channel === "variant" || control.channel === "reasoning.effort") {
    const strControl = control as StringReasoningControl;
    const clampedIdx = Math.min(Math.max(0, levelIndex), strControl.levels.length - 1);
    const native = strControl.levels[clampedIdx];
    return channelPatch(control.channel as ReasoningControlChannel, native);
  }

  // Budget-level control
  if (control.channel === "thinking.budgetTokens") {
    const numControl = control as BudgetReasoningControl;
    const clampedIdx = Math.min(Math.max(0, levelIndex), numControl.levels.length - 1);
    const native = numControl.levels[clampedIdx];
    return channelPatch(control.channel as ReasoningControlChannel, native);
  }

  return null;
};
