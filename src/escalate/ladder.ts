import type { RouterConfig } from "../router/config";
import { resolveLadder } from "../router/tier-ladder";
import { writeTrajectoryLog } from "../utils/log";
import { logEvent } from "../utils/observability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EscalatePolicy {
  ladder: string[];
  floorTier?: string | null;
  maxAttemptsPerTier: number;
  maxTotalAttempts: number;
  costMultiple?: number | null;
}

export interface LadderState {
  currentTier: string;
  attemptsThisTier: number;
  totalAttempts: number;
  escalations: number;
  firstAttemptCost: number | null;
  cumulativeCost: number;
  /** Current level index within the tier's reasoning ladder. Resets on tier change. */
  levelIndex: number;
  /** Number of level bumps applied within the current tier. Resets on tier change. */
  bumpsThisTier: number;
  /** Length of this tier's reasoning ladder (0 = no ladder). Set by enterTier. */
  reasoningLadderLen: number;
  /** Max bumps allowed within this tier (0 = bumping disabled). Set by enterTier. */
  tierMaxBumps: number;
}

export type LadderActionKind = "accept" | "retry" | "escalate" | "give_up" | "bump";

export interface LadderAction {
  action: LadderActionKind;
  tier?: string;
  forcingMessage?: string;
  reason?: string;
}

export interface LadderVerdict {
  pass: boolean;
  reasons?: string[];
  /** Why the verdict was reached. Used by canBumpReasoning to gate the bump branch. */
  cause?: "verification_fail" | "retryable_error";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const tierRank = (tier: string, ladder: string[]): number => {
  return ladder.indexOf(tier);
};

export const resolveStartTier = (producerTier: string, policy: EscalatePolicy): string => {
  const pi = tierRank(producerTier, policy.ladder);
  const fi = policy.floorTier != null ? tierRank(policy.floorTier, policy.ladder) : -1;
  const startIdx = Math.max(pi >= 0 ? pi : 0, fi >= 0 ? fi : 0);
  return policy.ladder[startIdx] ?? producerTier;
};

export const newLadderState = (producerTier: string, policy: EscalatePolicy): LadderState => {
  return {
    currentTier: resolveStartTier(producerTier, policy),
    attemptsThisTier: 0,
    totalAttempts: 0,
    escalations: 0,
    firstAttemptCost: null,
    cumulativeCost: 0,
    levelIndex: 0,
    bumpsThisTier: 0,
    reasoningLadderLen: 0,
    tierMaxBumps: 0,
  };
};

export const recordAttempt = (state: LadderState, costUnits = 0): LadderState => {
  return {
    ...state,
    totalAttempts: state.totalAttempts + 1,
    cumulativeCost: state.cumulativeCost + costUnits,
    firstAttemptCost: state.firstAttemptCost == null ? costUnits : state.firstAttemptCost,
  };
};

export const nextTierAfter = (currentTier: string, policy: EscalatePolicy): string | null => {
  const ci = tierRank(currentTier, policy.ladder);
  if (ci >= 0 && ci + 1 <= policy.ladder.length - 1) {
    const next = policy.ladder[ci + 1];
    return next ?? null;
  }
  return null;
};

export const buildLadderForcingMessage = (reasons: string[]): string => {
  const list =
    reasons.length === 0 ? "- (no reasons provided)" : reasons.map((r) => `- ${r}`).join("\n");
  return (
    `[router escalation] previous attempt did not pass verification:\n` +
    list +
    `\nNEXT: retry with these failures addressed.`
  );
};

/**
 * Pure gating function for the bump branch. Returns true only when:
 *   - bumping is enabled (state.tierMaxBumps > 0)
 *   - the current tier has a reasoning ladder (state.reasoningLadderLen > 0)
 *   - there are bumps remaining within this tier (state.bumpsThisTier < state.tierMaxBumps)
 *   - the current level is not the top (state.levelIndex < state.reasoningLadderLen - 1)
 *   - the verdict cause is "verification_fail" (not "retryable_error" or absent)
 *
 * D-2: policy param dropped; bumping eligibility is entirely state-local via tierMaxBumps.
 */
export const canBumpReasoning = (
  state: LadderState,
  verdict: LadderVerdict | null | undefined,
): boolean => {
  if (state.tierMaxBumps <= 0) return false;
  if (state.reasoningLadderLen <= 0) return false;
  if (state.bumpsThisTier >= state.tierMaxBumps) return false;
  if (state.levelIndex >= state.reasoningLadderLen - 1) return false;
  if (verdict?.cause !== "verification_fail") return false;
  return true;
};

/**
 * Pure predicate: true when bump is in play but cannot proceed (cap or top exhausted).
 * D-3: used to bypass the ordinary retry branch and escalate directly.
 * bumpExhausted = reasoningLadderLen > 0 && tierMaxBumps > 0 && cause === "verification_fail"
 *                && !canBumpReasoning(state, verdict)
 */
export const bumpExhausted = (
  state: LadderState,
  verdict: LadderVerdict | null | undefined,
): boolean => {
  if (state.reasoningLadderLen <= 0) return false;
  if (state.tierMaxBumps <= 0) return false;
  if (verdict?.cause !== "verification_fail") return false;
  // True when canBumpReasoning is false but we have a control + cause — exhaustion.
  return !canBumpReasoning(state, verdict);
};

export const nextAction = (
  state: LadderState,
  verdict: LadderVerdict | null | undefined,
  policy: EscalatePolicy,
  signal?: AbortSignal,
): LadderAction => {
  // (1) pass
  if (verdict?.pass === true) {
    return { action: "accept" };
  }

  // (2) abort guard — once the caller is cancelled, never retry or escalate.
  // Must run before any decision that could spawn another attempt.
  if (signal?.aborted) {
    return { action: "give_up", reason: "aborted" };
  }

  // (3) cost check
  const costExceeded =
    policy.costMultiple != null &&
    state.firstAttemptCost != null &&
    state.cumulativeCost > state.firstAttemptCost * policy.costMultiple;

  // (4) max total attempts
  if (state.totalAttempts >= policy.maxTotalAttempts) {
    return {
      action: "give_up",
      reason: `max total attempts (${policy.maxTotalAttempts}) reached`,
    };
  }

  // (5) cost ceiling
  if (costExceeded) {
    return { action: "give_up", reason: "cost ceiling exceeded" };
  }

  // (5.5) level bump — verification_fail ladder tiers escalate within tier
  // before retrying or escalating to the next tier.
  if (canBumpReasoning(state, verdict)) {
    return {
      action: "bump",
      tier: state.currentTier,
      forcingMessage: buildLadderForcingMessage(verdict?.reasons ?? []),
    };
  }
  // bumpExhausted: control in play but bump exhausted (cap or top) → escalate directly
  if (bumpExhausted(state, verdict)) {
    const next = nextTierAfter(state.currentTier, policy);
    if (next == null) {
      return {
        action: "give_up",
        reason: "no higher tier (already at top of ladder)",
      };
    }
    return {
      action: "escalate",
      tier: next,
      forcingMessage: buildLadderForcingMessage(verdict?.reasons ?? []),
    };
  }
  // (6) retry within tier — non-bump cases only (retryable, non-ladder,
  // feature-off, omitted cause) enter this branch byte-for-byte.
  if (state.attemptsThisTier < policy.maxAttemptsPerTier) {
    return {
      action: "retry",
      tier: state.currentTier,
      forcingMessage: buildLadderForcingMessage(verdict?.reasons ?? []),
    };
  }

  // (7) escalate or give_up
  const next = nextTierAfter(state.currentTier, policy);
  if (next == null) {
    return {
      action: "give_up",
      reason: "no higher tier (already at top of ladder)",
    };
  }
  return {
    action: "escalate",
    tier: next,
    forcingMessage: buildLadderForcingMessage(verdict?.reasons ?? []),
  };
};

export const advance = (state: LadderState, action: LadderAction): LadderState => {
  if (action.action === "retry") {
    return { ...state, attemptsThisTier: state.attemptsThisTier + 1 };
  }
  if (action.action === "bump") {
    // Bump advances the reasoning level within the current tier.
    // Does NOT increment attemptsThisTier — that counts produce attempts,
    // not internal reasoning-level steps.
    return {
      ...state,
      levelIndex: state.levelIndex + 1,
      bumpsThisTier: state.bumpsThisTier + 1,
    };
  }
  if (action.action === "escalate") {
    if (!action.tier) return state; // defensive — escalate always carries tier
    return {
      ...state,
      currentTier: action.tier,
      attemptsThisTier: 0,
      escalations: state.escalations + 1,
      levelIndex: 0,
      bumpsThisTier: 0,
      reasoningLadderLen: 0,
      tierMaxBumps: 0,
    };
  }
  // accept / give_up — terminal, return unchanged
  return state;
};

export const buildEscalatePolicy = (cfg: RouterConfig): EscalatePolicy => {
  const esc = cfg.enforcement?.escalate;
  return {
    ladder: esc?.ladder ?? resolveLadder(cfg),
    floorTier: esc?.floorTier ?? null,
    maxAttemptsPerTier: esc?.maxAttemptsPerTier ?? 1,
    maxTotalAttempts: esc?.maxTotalAttempts ?? 4,
    costMultiple: esc?.costCeiling?.multiple ?? 4,
  };
};

/**
 * One-line, secret-free scorecard for a finished delegation (counts only).
 */
export const formatLadderScorecard = (
  state: LadderState,
  accepted: boolean,
  method: string,
): string => {
  return (
    `[router delegate scorecard | final_tier=${state.currentTier} | ` +
    `attempts=${state.totalAttempts} | escalations=${state.escalations} | ` +
    `cost=${state.cumulativeCost} | verdict=${accepted ? "PASS" : "UNMET"} | ` +
    `method=${method}]`
  );
};

/** Append-only temp-file dump for a finished delegation. Writes under
 *  `<tmpdir>/opencode-smart-router-trajectory/<sid>.delegate.log` (same dir
 *  the event-hook scorecard uses) and never throws — a logging failure must
 *  never crash a real session. */
export const dumpDelegateScorecard = (
  sid: string,
  state: LadderState,
  accepted: boolean,
  method: string,
): void => {
  const line = formatLadderScorecard(state, accepted, method);
  writeTrajectoryLog(sid, line, "delegate");
  // PR5: structured outcome observability. The temp-file scorecard stays
  // as a forensic record; this line gives operators an at-a-glance
  // grep-able event without having to tail the trajectory dir.
  const payload = {
    sid,
    finalTier: state.currentTier,
    totalAttempts: state.totalAttempts,
    escalations: state.escalations,
    cost: state.cumulativeCost,
    verdict: accepted ? "PASS" : "UNMET",
    method,
  };
  if (accepted) {
    logEvent.routing.accepted(payload);
  } else {
    logEvent.routing.unmet(payload);
  }
};

/**
 * Emit a structured routing.escalated event when the ladder promotes a
 * producer to a higher tier. Called from `executeDelegate` immediately
 * after `advance()` runs the escalation transition. The from/to pair
 * lets operators reconstruct the ladder path per session without
 * correlating per-attempt logs.
 */
export const logEscalation = (
  sid: string,
  from: string,
  to: string,
  reason: string,
  attempts: number,
): void => {
  logEvent.routing.escalated({ sid, from, to, reason, attempts });
};

/**
 * Emit a structured routing.delegated event when a delegation attempt
 * begins. The `tier` is the producer tier for the attempt; the `attempt`
 * index is 1-based so logs line up with the ladder's `attemptsThisTier`.
 */
export const logDelegation = (
  sid: string,
  tier: string,
  attempt: number,
  isRetry: boolean,
): void => {
  logEvent.routing.delegated({ sid, tier, attempt, isRetry });
};
