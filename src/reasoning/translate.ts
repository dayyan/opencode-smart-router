// ---------------------------------------------------------------------------
// src/reasoning/translate.ts — Translate configured reasoning controls into
// provider-specific patches.
//
// Pure function. No router state, no side effects, no IO. Policy resolution
// (static / manual / adaptive) lives in `policy.ts`; this module only bridges
// opaque profiles to configured native levels.
//
// WU-2 (Plan 041): Two additional exports layer the v2 profile→native bridge:
//   resolveControlPatch(control, profileId) — resolves profile to {native, levelIndex}
//   patchAtIndex(control, levelIndex)        — applies clamped index to produce channel patch
// ---------------------------------------------------------------------------

import type {
  BudgetReasoningControl,
  ReasoningControl,
  ReasoningProfileId,
  StringReasoningControl,
} from "../router/config.types.js";
import { channelPatch, type ReasoningControlChannel } from "./capability.js";

/**
 * Provider-specific reasoning patch to apply on top of the static agent def.
 * Exactly one of `variant` or `options` MAY be set per call (a given capability
 * routes through one channel only — see `cap.field`).
 *
 * `null` is the canonical "no-op / capability can't satisfy this level"
 * sentinel. Callers honor `surfaceLimits` to decide whether to emit a note.
 */
export type ResolvedReasoning = { variant?: string; options?: Record<string, unknown> } | null;

// ---------------------------------------------------------------------------
// Profile → native bridge (Plan 041)
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
