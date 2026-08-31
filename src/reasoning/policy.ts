// ---------------------------------------------------------------------------
// src/reasoning/policy.ts — Resolve an effective reasoning override for a tier
// given the configured policy mode and a per-session override.
//
// This is the SINGLE place policy mode semantics live. The function is pure:
// no IO, no mutation, no module-level state. The runtime hooks
// (`src/plugin/runtime.ts`) and the `/reasoning` command handler both call it
// with the same inputs and get the same outputs.
//
// Modes:
//   - `static`   → ALWAYS null (primary regression guard). Even if a session
//                  override exists, static mode ignores it and the agent def
//                  is left exactly as `registerTierAgents` produced it. This
//                  preserves today's behaviour when `reasoningPolicy` is
//                  absent or `mode === "static"`.
//   - `manual`   → resolve `sessionOverride ?? policy.defaultLevel`, translate
//                  through the tier's capability. If both are undefined → null
//                  (no-op).
//   - `adaptive` → consult `selectAdaptiveLevel` (in `./adaptive.ts`) for a
//                  level picked from real task signals. Precedence, highest
//                  first:
//                      1. explicit `sessionOverride` (always wins)
//                      2. `selectAdaptiveLevel(signals, policy)` result
//                      3. `policy.defaultLevel` as a safety net
//                      4. null (no patch — agent def left at baseline)
//                  Every resolved level is passed through `translateLevel`
//                  so capability gating still applies; adaptive only picks
//                  the normalized level, not the provider-specific patch.
// ---------------------------------------------------------------------------

import type {
  ReasoningPolicyConfig,
  ReasoningPolicyConfigV2,
  TierConfig,
} from "../router/config.types.js";
import { type AdaptiveSignals, selectAdaptiveLevel, selectAdaptiveLevelV2 } from "./adaptive.js";
import { inferCapability, type ReasoningLevel } from "./capability.js";
import { type ResolvedReasoning, translateLevel } from "./translate.js";

/**
 * Resolve the effective reasoning patch for a tier under the configured policy.
 *
 * The `sessionOverride` is sourced from `reasoningStore.get(sessionID)`. The
 * hook layer decides whether to thread it (manual mode reads it; static mode
 * ignores it; adaptive mode reads it FIRST so a per-session override always
 * wins over selector output — operators need certainty when they set it
 * manually via `/model-router-reasoning elevated`).
 *
 * The `signals` argument is required — it feeds `selectAdaptiveLevel` in
 * adaptive mode. Hooks that haven't yet threaded real task text (today:
 * `src/plugin/hooks.ts` — wired in a later PR of Plan 015) pass an empty
 * `{ prompt: "", description: "", tierName, isTrivial }` placeholder; the
 * selector's keyword step is a substring match against an empty haystack so
 * non-trivial calls fall through to `tierDefaults` / `defaultLevel` safely.
 *
 * Returns `null` when:
 *   - the policy mode is `static`, OR
 *   - no level resolves (no override + no adaptive block + no defaultLevel),
 *     OR
 *   - the tier's capability cannot satisfy the level (`none`, or `binary`
 *     with no baseline for a low-rank level — see `translateLevel`).
 *
 * `surfaceLimits` is intentionally NOT consulted here — surfacing is a
 * presentation concern owned by the `/reasoning` command handler and the
 * runtime log layer. The flag's only effect on this function is that the
 * resolved patch is identical regardless of its value (proved in
 * `reasoning-policy.test.ts`).
 */
export const resolveReasoningOverride = (
  tier: TierConfig,
  policy: ReasoningPolicyConfig | undefined,
  sessionOverride: ReasoningLevel | undefined,
  signals: AdaptiveSignals,
): ResolvedReasoning => {
  const mode = policy?.mode ?? "static";

  // Primary regression guard: static mode is a hard no-op, regardless of any
  // session override. This keeps the agent def exactly as `registerTierAgents`
  // produced it when `reasoningPolicy` is absent or `mode === "static"`.
  if (mode === "static") return null;

  // Manual mode: pre-Plan-015 semantics, unchanged. A per-session override
  // wins over `policy.defaultLevel`; either way we translate through the
  // tier's capability.
  if (mode === "manual") {
    const level = sessionOverride ?? policy?.defaultLevel;
    if (!level) return null;
    const cap = tier.capability ?? inferCapability(tier);
    return translateLevel(cap, level);
  }

  // Unknown mode gate (fail-soft): any mode value that is not exactly one
  // of the three recognized modes (`static` / `manual` / `adaptive`) MUST
  // resolve to null. This catches typos (e.g. `"adaptive-typo"`) and any
  // future-unknown string BEFORE adaptive selection runs, so a malformed
  // config can never silently elevate reasoning. Adding a new mode requires
  // touching this gate so the call site cannot drift past it unnoticed.
  if (mode !== "adaptive") return null;

  // mode === "adaptive"
  // Precedence (highest first; mirroring the file header):
  //   1. explicit `sessionOverride` (always wins)
  //   2. `selectAdaptiveLevel(signals, policy)` result
  //   3. `policy.defaultLevel` as a safety net
  //   4. null (no patch — agent def left at baseline)
  if (sessionOverride) {
    const cap = tier.capability ?? inferCapability(tier);
    return translateLevel(cap, sessionOverride);
  }

  const decision = selectAdaptiveLevel(signals, policy);
  const level = decision.level ?? policy?.defaultLevel;
  if (!level) return null;

  const cap = tier.capability ?? inferCapability(tier);
  return translateLevel(cap, level);
};

// ---------------------------------------------------------------------------
// resolveReasoningProfile — plan 041 D-1 tier-agnostic helper
//
// This is the SINGLE helper used by BOTH the task-tool hook path and the
// delegate path (per D-1). Tier-agnostic: resolution is purely on the policy
// registry + session override + adaptive signals; the per-tier control mapping
// happens at the call site via `resolveControlPatch`.
//
// Mode semantics (preserved verbatim from the v1 resolver):
//   static    → { profile: null }                    (no patch; static baseline serves)
//   unknown   → { profile: null }                    (fail-soft; adaptive never runs)
//   manual    → override ?? defaultProfile            (overrideUnknown when unregistered)
//   adaptive  → override wins, then selector, then defaultProfile
//
// Unregistered override: logged at the call site as `reasoning.override_unknown_profile`;
// control returns to the configured policy (overrideUnknown: true).
// ---------------------------------------------------------------------------

/** Return type of `resolveReasoningProfile`. */
export interface ReasoningResolution {
  /** The resolved profile ID, or null when static/unknown/no-selection. */
  profile: import("../router/config.types.js").ReasoningProfileId | null;
  /**
   * True when an override was set but is not a registered profile ID.
   * The caller should log `reasoning.override_unknown_profile` and apply
   * the policy default instead.
   */
  overrideUnknown: boolean;
}

/**
 * Resolve the effective reasoning profile for a policy, session override,
 * and dispatch-time signals.
 *
 * This function is TIER-AGNOSTIC — it operates on the global registry and
 * adaptive signals only. The per-tier native-value mapping (`profileMap`)
 * is applied by the call site via `resolveControlPatch`.
 *
 * Both the task-tool hook path (`tool-guards.ts applyOrchestratorReasoningPatch`)
 * and the delegate path (`delegate.ts enterTier`) call this function with the
 * same arguments and receive the same result (D-1).
 *
 * Returns `{ profile: null }` when:
 *   - policy mode is `static` (even with a stored override)
 *   - mode is unrecognized (fail-soft)
 *   - no profile resolves and no default exists
 */
export const resolveReasoningProfile = (
  policy: ReasoningPolicyConfigV2 | undefined,
  sessionOverride: string | undefined,
  signals: AdaptiveSignals,
): ReasoningResolution => {
  const mode = policy?.mode ?? "static";

  // static: hard regression guard — no patch regardless of any override.
  if (mode === "static") {
    return { profile: null, overrideUnknown: false };
  }

  // Unknown mode gate (fail-soft): adaptive selection MUST NOT run.
  if (mode !== "manual" && mode !== "adaptive") {
    return { profile: null, overrideUnknown: false };
  }

  // manual / adaptive: check session override first.
  let overrideUnknown = false;
  if (sessionOverride !== undefined) {
    const registered = policy?.profiles?.includes(sessionOverride) ?? false;
    if (registered) {
      // Registered override wins regardless of mode.
      return { profile: sessionOverride, overrideUnknown: false };
    }
    // Unregistered override: flag, fall through to policy default or selector.
    // Call site logs "reasoning.override_unknown_profile".
    overrideUnknown = true;
  }

  // adaptive mode: run the selector; fall through to defaultProfile.
  if (mode === "adaptive") {
    const decision = selectAdaptiveLevelV2(signals, policy);
    const profile = decision.profile ?? policy?.defaultProfile ?? null;
    return { profile, overrideUnknown };
  }

  // manual with no valid override: use defaultProfile.
  return {
    profile: policy?.defaultProfile ?? null,
    overrideUnknown,
  };
};
