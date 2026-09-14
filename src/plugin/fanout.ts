// Fanout tool executor (PR 3b) — parallel worker lifecycle + markdown aggregate.
// Admission: depth===1, caller tier {medium|focused|heavy}, not producer/grader/worker,
// enabled, breaker closed, non-empty items, items.length <= maxWorkersPerBatch.
import { log } from "../utils/observability";
import { resolveTierModelGuard } from "../utils/tier-model-guard";
import { withTimeout } from "../utils/timeout";
import type { PluginContext } from "./context";
import type { FanoutArgs, FanoutItemResult } from "./types";
import { extractPromptText } from "./types";

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
 */
export const formatRejectedAggregate = (reason: string): string => {
  return `## fanout batch rejected\n\n- **reason**: ${reason}\n`;
};

// ---------------------------------------------------------------------------
// Worker session cleanup (adapted from delegate.ts cleanupProducerSession)
// ---------------------------------------------------------------------------

/**
 * Clean up all per-worker session state. Called from the per-worker finally
 * block and from early-return paths when session.create succeeds but the
 * subsequent steps fail.
 *
 * session.delete is NEVER called (SDD fix-session-ghost-tui-jump binding rule).
 * session.abort is called on failure paths only (workerSucceeded === false)
 * to avoid discarding a completed session that a developer may want to review.
 */
const cleanupWorkerSession = async (
  ctx: PluginContext,
  workerSid: string,
  workerSucceeded: boolean,
): Promise<void> => {
  try {
    ctx.changedFileStore.clear(workerSid);
  } catch (err) {
    log.warn({
      event: "fanout.worker_cleanup_failed",
      store: "changedFileStore.clear",
      sid: workerSid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    ctx.sessionStore.unregister(workerSid);
  } catch (err) {
    log.warn({
      event: "fanout.worker_cleanup_failed",
      store: "sessionStore.unregister",
      sid: workerSid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    ctx.guardStore.clear(workerSid);
  } catch (err) {
    log.warn({
      event: "fanout.worker_cleanup_failed",
      store: "guardStore.clear",
      sid: workerSid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // SDK teardown — fail-soft, null-safe, independent timeouts.
  // session.delete is NEVER called (binding rule from plan 044).
  // session.abort is conditional: only called on non-success paths.
  if (!workerSucceeded && workerSid) {
    try {
      await withTimeout(
        ctx.plugin.client.session.abort({ path: { id: workerSid } }),
        10_000,
        "fanout session.abort",
      );
    } catch (err) {
      log.warn({
        event: "fanout.worker_cleanup_failed",
        store: "session.abort",
        sid: workerSid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};

// ---------------------------------------------------------------------------
// Per-worker slot cleanup helper
// ---------------------------------------------------------------------------

/** Releases a fanout slot. Always called from a finally block — never throws. */
const releaseFanoutSlot = (ctx: PluginContext, tier: string): void => {
  try {
    ctx.fanoutStore.release(tier);
  } catch (err) {
    log.warn({
      event: "fanout.slot_release_failed",
      tier,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

// ---------------------------------------------------------------------------
// Markdown aggregation helpers
// ---------------------------------------------------------------------------

const formatItemResult = (item: FanoutItemResult): string => {
  const line = `## [${item.index + 1}] tier=${item.tier} status=${item.status}`;
  if (item.text) {
    return `${line}\n${item.text}`;
  }
  if (item.reason) {
    return `${line}\n(${item.reason})`;
  }
  return `${line}`;
};

// ---------------------------------------------------------------------------
// Real executor
// ---------------------------------------------------------------------------

/**
 * Execute fanout — real parallel executor (PR 3b).
 *
 * Runs all workers in parallel, races against batchTimeoutMs, and returns a
 * markdown aggregate. Each worker:
 *   1. Acquires a fanout slot (rejects item on cap/breaker fail)
 *   2. Creates a session with parentID = root session (caller's parent's sid)
 *   3. Marks the session as a fanout worker
 *   4. Guards on tier model config (rejects item on invalid config)
 *   5. Runs session.prompt with workerTimeoutMs
 *   6. On success: preserves session for review
 *   7. On failure/timeout: aborts session with 10s timeout
 *   8. Releases fanout slot in finally block
 *
 * When the caller's AbortSignal fires, all outstanding workers are aborted
 * and the function returns "" silently (matching delegate.ts cancellation contract).
 */
export const executeFanout = async (
  ctx: PluginContext,
  args: FanoutArgs,
  callerSid: string,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const cfg = await ctx.getFreshConfig();
  const fanoutCfg = cfg.fanout;

  // --- Admission gate (same as PR 3a stub, plus caller-is-not-root check) ---

  const depth = ctx.sessionStore.depth(callerSid);
  if (depth !== 1) {
    return formatRejectedAggregate(`depth ${depth} !== 1; fanout requires depth-1 caller`);
  }

  const callerTier = ctx.sessionStore.getTier(callerSid) ?? "unknown";
  if (!CALLER_TIER_ALLOWLIST.has(callerTier)) {
    return formatRejectedAggregate(
      `caller tier '${callerTier}' not in allowlist; medium/heavy callers only`,
    );
  }

  if (ctx.sessionStore.isProducerSession(callerSid)) {
    return formatRejectedAggregate("producer sessions cannot call fanout");
  }

  if (ctx.graderSessions.has(callerSid)) {
    return formatRejectedAggregate("grader sessions cannot call fanout");
  }

  if (ctx.sessionStore.isFanoutWorker(callerSid)) {
    return formatRejectedAggregate("fanout workers cannot call fanout");
  }

  if (fanoutCfg?.enabled !== true) {
    return formatRejectedAggregate("fanout disabled (kill switch)");
  }

  // Breaker FSM: reject only when explicitly `open`. `half_open` admits a
  // single probe batch (the design's recovery contract); `closed` admits
  // normally.
  if (ctx.fanoutStore.breakerState() === "open") {
    return formatRejectedAggregate("circuit breaker open");
  }

  if (args.items.length === 0) {
    return formatRejectedAggregate("empty batch; items array must be non-empty");
  }

  const workerAllowlist =
    callerTier === "medium" ? MEDIUM_CALLER_WORKER_ALLOWLIST : HIGH_TIER_WORKER_ALLOWLIST;

  // --- Caller must have a parent (workers are siblings of the caller, not children) ---
  const rootSid = ctx.sessionStore.parentOf(callerSid);
  if (!rootSid) {
    return formatRejectedAggregate(
      "caller is root session; fanout workers require a parent session",
    );
  }

  // --- Batch-level cap ---
  if (args.items.length > fanoutCfg.maxWorkersPerBatch) {
    return formatRejectedAggregate(
      `items.length ${args.items.length} > maxWorkersPerBatch ${fanoutCfg.maxWorkersPerBatch}`,
    );
  }

  // --- Per-item policy + slot acquisition ---
  // Policy check is per-item: invalid tier edges get per-item rejection, siblings proceed.
  // Empty prompt is also per-item rejection. Slot acquisition failure is per-item;
  // batch rejection only if ALL items fail slot (not policy/empty).
  const itemResults = args.items.map((item) => {
    // Policy check: is this tier allowed for this caller?
    if (!workerAllowlist.has(item.tier)) {
      return {
        item,
        slotAcquired: false as const,
        policyRejected: true as const,
        reason: `tier '${item.tier}' not allowed for '${callerTier}' caller; allowed: ${[...workerAllowlist].join(", ")}`,
      };
    }
    // Empty prompt check: per-item rejection, siblings proceed
    if (!item.prompt || item.prompt.trim() === "") {
      return {
        item,
        slotAcquired: false as const,
        policyRejected: true as const,
        reason: "empty prompt",
      };
    }
    // Try to acquire fanout slot
    const acquire = ctx.fanoutStore.tryAcquire(item.tier);
    if (!acquire.ok) {
      return {
        item,
        slotAcquired: false as const,
        policyRejected: false as const,
        reason: `fanout_slot_acquire: ${acquire.reason}`,
      };
    }
    return { item, slotAcquired: true as const, policyRejected: false as const };
  });

  // If ALL items failed slot acquisition (not policy), return batch-level rejection.
  // Policy failures are per-item; they don't cause batch rejection.
  const allSlotFailed = itemResults.every((r) => !r.slotAcquired);
  if (allSlotFailed) {
    const reason = itemResults
      .filter((r) => !r.slotAcquired)
      .map((r) => `${r.item.tier}: ${r.reason}`)
      .join("; ");
    return formatRejectedAggregate(`all fanout slots rejected: ${reason}`);
  }

  // --- Caller abort: abort all outstanding workers and return "" silently ---
  if (signal?.aborted) {
    return "";
  }

  // --- Build per-worker promises ---
  const workerPromises = itemResults.map(async (result, idx): Promise<FanoutItemResult> => {
    // Per-item policy rejection (siblings proceed)
    if (result.policyRejected) {
      return {
        index: idx,
        tier: result.item.tier,
        status: "rejected",
        reason: result.reason,
      };
    }

    if (!result.slotAcquired) {
      return {
        index: idx,
        tier: result.item.tier,
        status: "rejected",
        reason: result.reason,
      };
    }

    const item = result.item;

    // Release fanout slot in ALL exit paths (success, fail, timeout, throw)
    try {
      // 1. Create session with root as parent (NOT callerSid — no grandchild invariant)
      let workerSid: string;
      try {
        const created = await withTimeout(
          ctx.plugin.client.session.create({
            body: { parentID: rootSid },
            ...(signal ? { signal } : {}),
          }),
          30_000,
          "fanout session.create",
          signal,
        );
        workerSid = created?.data?.id ?? "";
      } catch (err) {
        if (
          err instanceof DOMException ||
          (err !== null && typeof err === "object" && "name" in err && err.name === "AbortError")
        ) {
          return {
            index: idx,
            tier: item.tier,
            status: "cancelled",
            reason: "session.create aborted",
          };
        }
        return {
          index: idx,
          tier: item.tier,
          status: "failed",
          reason: `session.create threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!workerSid) {
        return {
          index: idx,
          tier: item.tier,
          status: "failed",
          reason: "session.create returned no id",
        };
      }

      // 2. Mark as fanout worker (NEW — added in PR 1)
      try {
        ctx.sessionStore.markFanoutWorker(workerSid);
      } catch (err) {
        log.warn({
          event: "fanout.worker_register_failed",
          sid: workerSid,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 3. Register producer session (fail-soft)
      try {
        ctx.sessionStore.registerProducerSession(workerSid, item.tier, cfg);
      } catch (err) {
        log.warn({
          event: "fanout.worker_register_failed",
          sid: workerSid,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      let workerSucceeded = false;

      try {
        // 4. Guard on tier model config (fail-fast on invalid tier config)
        const guard = resolveTierModelGuard(cfg, item.tier);
        if (!guard.ok) {
          return { index: idx, tier: item.tier, status: "rejected", reason: guard.reason };
        }
        const model = guard.model;

        // 5. Run prompt with worker timeout
        try {
          const res = await withTimeout(
            ctx.plugin.client.session.prompt({
              path: { id: workerSid },
              ...(signal ? { signal } : {}),
              body: {
                ...(model ? { model } : {}),
                agent: item.tier,
                parts: [{ type: "text", text: item.prompt }],
              },
            }),
            fanoutCfg.workerTimeoutMs,
            "fanout session.prompt",
            signal,
          );
          const text = extractPromptText(res);
          workerSucceeded = true;
          return { index: idx, tier: item.tier, status: "completed", text };
        } catch (err) {
          if (
            err instanceof DOMException ||
            (err !== null && typeof err === "object" && "name" in err && err.name === "AbortError")
          ) {
            return {
              index: idx,
              tier: item.tier,
              status: "cancelled",
              reason: "session.prompt aborted",
            };
          }
          // Timeout: withTimeout throws Error("... timed out after Nms")
          if (err instanceof Error && err.message.includes("timed out")) {
            return {
              index: idx,
              tier: item.tier,
              status: "timed_out",
              reason: `worker exceeded ${fanoutCfg.workerTimeoutMs}ms; abort attempted`,
            };
          }
          return {
            index: idx,
            tier: item.tier,
            status: "failed",
            reason: `session.prompt threw: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } finally {
        // 6. Cleanup: abort on failure/timeout, preserve on success
        await cleanupWorkerSession(ctx, workerSid, workerSucceeded);
      }
    } finally {
      // 7. ALWAYS release fanout slot (both success and failure paths)
      releaseFanoutSlot(ctx, item.tier);
    }
  });

  // --- Race all workers against batchTimeoutMs ---
  let batchTimedOut = false;
  const batchPromise = Promise.allSettled(workerPromises);

  try {
    await withTimeout(batchPromise, fanoutCfg.batchTimeoutMs, "fanout batch", signal);
  } catch {
    batchTimedOut = true;
  }

  if (batchTimedOut) {
    // On batch timeout, we return what we have. In-flight workers will
    // self-cleanup via their finally blocks when their prompts time out.
    void workerPromises;
  }

  // --- Aggregate ---
  const rawResults = await batchPromise;
  const items: FanoutItemResult[] = rawResults.map((result, idx) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      index: idx,
      tier: args.items[idx]?.tier ?? "unknown",
      status: "failed",
      reason: `promise settled with rejection: ${result.reason}`,
    };
  });

  // Record batch outcome for breaker
  const hasFailure = items.some(
    (r) => r.status === "failed" || r.status === "timed_out" || r.status === "cancelled",
  );
  if (hasFailure) {
    ctx.fanoutStore.recordOutcome("failed");
  } else if (items.every((r) => r.status === "completed")) {
    ctx.fanoutStore.recordOutcome("completed");
  }

  // Format aggregate
  if (items.length === 0) {
    return formatRejectedAggregate("no items processed");
  }

  const lines = items.map(formatItemResult);
  return lines.join("\n\n");
};
