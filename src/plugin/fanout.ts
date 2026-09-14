// Fanout tool stub executor (PR 3a) — admission gate + typed rejected returns.
// Admission: depth===1, caller tier {medium|focused|heavy}, not producer/grader/worker, enabled, breaker closed, non-empty items.
import type { PluginContext } from "./context";
import type { FanoutArgs } from "./types";

// ---------------------------------------------------------------------------
// Policy matrix constants
// ---------------------------------------------------------------------------

/** Tiers that can call fanout (callers): medium, focused, heavy. */
const CALLER_TIER_ALLOWLIST = new Set(["medium", "focused", "heavy"]);

/** Tiers that can be workers (callees) when caller is medium. */
const MEDIUM_CALLER_WORKER_ALLOWLIST = new Set(["fast"]);

/** Tiers that can be workers when caller is focused or heavy. */
const HIGH_TIER_WORKER_ALLOWLIST = new Set(["fast", "light", "medium"]);

// ---------------------------------------------------------------------------
// Helper: format a typed rejected aggregate
// ---------------------------------------------------------------------------

/**
 * Format a batch-level rejection as a markdown aggregate string.
 * This is the output returned by the stub when any admission check fails.
 */
export const formatRejectedAggregate = (reason: string): string => {
  return `## fanout batch rejected\n\n- **reason**: ${reason}\n`;
};

// ---------------------------------------------------------------------------
// Stub executor
// ---------------------------------------------------------------------------

/**
 * Execute fanout — stub implementation (PR 3a).
 *
 * This is a STUB: it runs the admission gate and returns typed `rejected`
 * for every case. The real parallel executor with worker lifecycle management
 * is implemented in PR 3b.
 *
 * The admission gate is fully functional and tested by the contract tests.
 */
export const executeFanout = async (
  ctx: PluginContext,
  args: FanoutArgs,
  callerSid: string,
  _signal: AbortSignal | undefined,
): Promise<string> => {
  // D-4: re-read fresh config for enabled flag
  const cfg = await ctx.getFreshConfig();
  const fanoutCfg = cfg.fanout;

  // Check 1: depth === 1
  const depth = ctx.sessionStore.depth(callerSid);
  if (depth !== 1) {
    return formatRejectedAggregate(`depth ${depth} !== 1; fanout requires depth-1 caller`);
  }

  // Check 2: caller tier in allowlist
  const callerTier = ctx.sessionStore.getTier(callerSid) ?? "unknown";
  if (!CALLER_TIER_ALLOWLIST.has(callerTier)) {
    return formatRejectedAggregate(
      `caller tier '${callerTier}' not in allowlist; medium/heavy callers only`,
    );
  }

  // Check 3: not a producer session
  if (ctx.sessionStore.isProducerSession(callerSid)) {
    return formatRejectedAggregate("producer sessions cannot call fanout");
  }

  // Check 4: not a grader session
  if (ctx.graderSessions.has(callerSid)) {
    return formatRejectedAggregate("grader sessions cannot call fanout");
  }

  // Check 5: not a fanout worker
  if (ctx.sessionStore.isFanoutWorker(callerSid)) {
    return formatRejectedAggregate("fanout workers cannot call fanout");
  }

  // Check 6: fresh config enabled flag
  if (fanoutCfg?.enabled !== true) {
    return formatRejectedAggregate("fanout disabled (kill switch)");
  }

  // Check 7: breaker closed
  if (ctx.fanoutStore.breakerState() !== "closed") {
    return formatRejectedAggregate("circuit breaker open");
  }

  // Check 8: non-empty items
  if (args.items.length === 0) {
    return formatRejectedAggregate("empty batch; items array must be non-empty");
  }

  // Determine worker allowlist based on caller tier
  const workerAllowlist =
    callerTier === "medium" ? MEDIUM_CALLER_WORKER_ALLOWLIST : HIGH_TIER_WORKER_ALLOWLIST;

  // Check each item's tier against the policy matrix
  for (const item of args.items) {
    if (!workerAllowlist.has(item.tier)) {
      return formatRejectedAggregate(
        `tier '${item.tier}' not allowed for '${callerTier}' caller; allowed: ${[...workerAllowlist].join(", ")}`,
      );
    }
  }

  // STUB: all gates pass but we still return rejected (real executor is PR 3b)
  return formatRejectedAggregate("stub: real executor not yet implemented (PR 3b)");
};
