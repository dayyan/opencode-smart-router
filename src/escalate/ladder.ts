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
  reasoningEscalation?: {
    enabled?: boolean;
    maxLevelBumpsPerTier?: number;
  };
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
 *   - feature is enabled (policy.reasoningEscalation.enabled === true)
 *   - the current tier has a reasoning ladder (state.reasoningLadderLen > 0)
 *   - there are bumps remaining within this tier
 *     (state.bumpsThisTier < policy.reasoningEscalation.maxLevelBumpsPerTier)
 *   - the verdict cause is "verification_fail" (not "retryable_error" or absent)
 */
export const canBumpReasoning = (
  state: LadderState,
  policy: EscalatePolicy,
  verdict: LadderVerdict | null | undefined,
): boolean => {
  const re = policy.reasoningEscalation;
  if (!re?.enabled) return false;
  if (state.reasoningLadderLen <= 0) return false;
  const bumpsLeft = (re.maxLevelBumpsPerTier ?? 2) - state.bumpsThisTier;
  if (bumpsLeft <= 0) return false;
  if (verdict?.cause !== "verification_fail") return false;
  return true;
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

  // (6) retry within tier
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
  if (action.action === "escalate") {
    if (!action.tier) return state; // defensive — escalate always carries tier
    return {
      ...state,
      currentTier: action.tier,
      attemptsThisTier: 0,
      escalations: state.escalations + 1,
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
    reasoningEscalation: esc?.reasoningEscalation ?? { enabled: false, maxLevelBumpsPerTier: 2 },
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
