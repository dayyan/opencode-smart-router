// ---------------------------------------------------------------------------
// Fanout containment store — per-plugin-instance control plane for fanout.
//
// Tracks per-tier + global active worker counts and implements the circuit
// breaker FSM (closed → open → half_open → closed|open) that gates
// admission of new fanout batches.
//
// All state is per-plugin-instance via `createFanoutStore()`. There is no
// module-level singleton — each PluginContext gets its own store.
// ---------------------------------------------------------------------------

import type { FanoutConfig } from "../router/config.types";

/** Outcome kinds recorded by the store.
 *
 *  Qualifying failures (trip the breaker; increment streak):
 *    `timed_out`      — worker exceeded workerTimeoutMs
 *    `abort_failed`   — cleanup session.abort exceeded 10s timeout (cleanup abort failure)
 *
 *  Non-qualifying (reset streak to 0 in closed state):
 *    `completed`  — all workers succeeded
 *    `failed`     — non-retryable prompt error (session.prompt threw)
 *    `cancelled`  — caller signal fired (session.create/prompt AbortError)
 *    `rejected`   — per-item policy rejection
 */
export type OutcomeKind =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "rejected"
  | "abort_failed";

/** Result of a `tryAcquire` call. */
export interface AcquireResult {
  ok: true;
  reason?: undefined;
}

export interface AcquireFailResult {
  ok: false;
  reason: "global_cap" | "tier_cap" | "circuit_open";
}

/** The fanout store interface. Returned by `createFanoutStore()`. */
export interface FanoutStore {
  /**
   * Configure (or reconfigure) the store with the given fanout config.
   * Called by executeFanout after the admission gate so that user-supplied
   * caps and breaker thresholds are actually enforced.
   *
   * Idempotent: can be called multiple times over the store's lifetime.
   */
  configure(cfg: FanoutConfig): void;

  /**
   * Attempt to acquire a fanout slot for `tier`.
   *
   * Atomically checks:
   *  1. Circuit breaker is not open (closed or half_open; note that
   *     the breaker transitions from open→half_open lazily on the first
   *     tryAcquire after cooldown elapses)
   *  2. Global active count < maxConcurrentGlobal
   *  3. Tier active count < maxConcurrentPerTier[tier]
   *
   * In `half_open` state only ONE probe slot exists. Once a probe slot is
   * acquired, subsequent tryAcquire calls in the same half_open window are
   * rejected with `circuit_open` until the probe outcome is recorded.
   *
   * Returns `{ ok: true }` on success (increments both counters).
   * Returns `{ ok: false, reason }` on failure (no side effects).
   */
  tryAcquire(tier: string): AcquireResult | AcquireFailResult;

  /**
   * Release a fanout slot for `tier` (called in the per-worker finally block).
   * Decrements both the tier counter and the global counter.
   */
  release(tier: string): void;

  /**
   * Record the outcome of a worker or batch.
   *
   * Qualifying failures (increment streak; trip breaker at threshold):
   *   `timed_out`    — worker exceeded workerTimeoutMs
   *   `abort_failed` — cleanup session.abort exceeded 10s timeout
   *
   * Non-qualifying (reset streak to 0 in closed state):
   *   `completed`  — all workers succeeded
   *   `failed`     — non-retryable prompt error (session.prompt threw)
   *   `cancelled`  — caller signal fired (session.create/prompt AbortError)
   *   `rejected`   — per-item policy rejection
   *
   * Special transitions:
   *   - `completed` in `half_open` → transitions breaker to `closed`
   *   - `timed_out` or `abort_failed` in `half_open` → re-opens breaker
   *   - `failed` in `half_open` → closes breaker (probe succeeded despite prompt error)
   */
  recordOutcome(kind: OutcomeKind): void;

  /** Read-only accessor for the current breaker state. */
  breakerState(): "closed" | "open" | "half_open";
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Build a fresh per-plugin fanout containment store.
 *
 * The store is functional without any explicit config (uses Required<FanoutConfig>
 * defaults internally). Callers MUST call configure(cfg) before use so that
 * user-supplied caps and breaker thresholds are enforced (R-3).
 */
export const createFanoutStore = (): FanoutStore => {
  // Per-tier active worker counts.
  const activeByTier = new Map<string, number>();

  // Global active worker count.
  let activeGlobal = 0;

  // Circuit breaker state machine.
  // DO NOT export directly — only through breakerState() accessor.
  let _breakerState: "closed" | "open" | "half_open" = "closed";
  let _consecutiveFailures = 0;
  let _openedAt: number | null = null;

  // Mutable config — updated via configure(). Start with required defaults
  // so the store is functional before configure() is called.
  let _maxConcurrentGlobal = 6;
  let _maxConcurrentPerTier: Record<string, number> = { fast: 4, light: 2, medium: 1 };
  let _failureThreshold = 3;
  let _cooldownMs = 60_000;

  const configure: FanoutStore["configure"] = (cfg) => {
    _maxConcurrentGlobal = cfg.maxConcurrentGlobal ?? 6;
    _maxConcurrentPerTier = { ...(cfg.maxConcurrentPerTier ?? { fast: 4, light: 2, medium: 1 }) };
    _failureThreshold = cfg.breaker?.failureThreshold ?? 3;
    _cooldownMs = cfg.breaker?.cooldownMs ?? 60_000;
  };

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  const getTierActive = (tier: string): number => activeByTier.get(tier) ?? 0;

  const setTierActive = (tier: string, n: number): void => {
    if (n <= 0) activeByTier.delete(tier);
    else activeByTier.set(tier, n);
  };

  const tryTransitionOpenToHalfOpen = (): boolean => {
    if (_breakerState !== "open") return false;
    if (_openedAt === null) return false;
    if (Date.now() - _openedAt < _cooldownMs) return false;
    // Transition lazily here — the first tryAcquire after cooldown elapses
    // promotes open → half_open and allows one probe.
    _breakerState = "half_open";
    return true;
  };

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const tryAcquire: FanoutStore["tryAcquire"] = (tier) => {
    // 1. Circuit breaker check
    if (_breakerState === "open") {
      if (!tryTransitionOpenToHalfOpen()) {
        return { ok: false, reason: "circuit_open" };
      }
      // Falls through to half_open handling below
    }

    if (_breakerState === "half_open") {
      // Only ONE probe slot is allowed in half_open. If activeGlobal > 0,
      // it means a probe is already in flight (the slot was acquired when
      // transitioning from open→half_open). Reject additional acquisitions.
      if (activeGlobal > 0) {
        return { ok: false, reason: "circuit_open" };
      }
      // Transition to half_open was just done above (or state was already half_open).
      // Allow the probe through.
    }

    // 2. Global cap check
    if (activeGlobal >= _maxConcurrentGlobal) {
      return { ok: false, reason: "global_cap" };
    }

    // 3. Per-tier cap check
    const tierCap = _maxConcurrentPerTier[tier] ?? Infinity;
    if (getTierActive(tier) >= tierCap) {
      return { ok: false, reason: "tier_cap" };
    }

    // All checks passed — acquire the slot
    activeGlobal += 1;
    setTierActive(tier, getTierActive(tier) + 1);

    return { ok: true };
  };

  const release: FanoutStore["release"] = (tier) => {
    if (activeGlobal > 0) activeGlobal -= 1;
    const current = getTierActive(tier);
    if (current > 0) setTierActive(tier, current - 1);
    // Idempotent: releasing without a prior acquire simply floors at zero.
  };

  const recordOutcome: FanoutStore["recordOutcome"] = (kind) => {
    // Non-qualifying outcomes reset streak in closed state.
    // `completed` in half_open also closes the breaker.
    if (kind === "completed" || kind === "cancelled" || kind === "rejected") {
      if (_breakerState === "half_open") {
        // Special case: completed in half_open closes the breaker (probe succeeded)
        _breakerState = "closed";
        _consecutiveFailures = 0;
        _openedAt = null;
      }
      // In closed state: reset streak to 0 (D-3 contract)
      if (_breakerState === "closed") {
        _consecutiveFailures = 0;
      }
      return;
    }

    // `failed` = non-retryable prompt error (non-qualifying per D-3).
    // Resets streak in closed; closes breaker in half_open (probe succeeded).
    if (kind === "failed") {
      if (_breakerState === "half_open") {
        // Probe succeeded despite a prompt error — close the breaker
        _breakerState = "closed";
        _consecutiveFailures = 0;
        _openedAt = null;
        return;
      }
      // In closed state: reset streak to 0
      _consecutiveFailures = 0;
      return;
    }

    // Qualifying failures: timed_out (worker timeout) and abort_failed (cleanup abort
    // timeout). Both increment the streak and trip the breaker at threshold.
    _consecutiveFailures += 1;

    if (_breakerState === "half_open") {
      // Probe failed — re-open with a new openedAt timestamp
      _breakerState = "open";
      _openedAt = Date.now();
      _consecutiveFailures = 1; // reset streak; the re-open counts as 1
      return;
    }

    // closed → open transition
    if (_breakerState === "closed" && _consecutiveFailures >= _failureThreshold) {
      _breakerState = "open";
      _openedAt = Date.now();
    }
    // If not yet at threshold, stay closed — streak continues to accumulate
  };

  const breakerState: FanoutStore["breakerState"] = () => {
    // If open but cooldown has elapsed, lazily report half_open so callers
    // know a probe is now possible (even though the actual transition
    // to half_open happens in tryAcquire).
    if (_breakerState === "open" && _openedAt !== null) {
      if (Date.now() - _openedAt >= _cooldownMs) {
        return "half_open";
      }
    }
    return _breakerState;
  };

  return { configure, tryAcquire, release, recordOutcome, breakerState };
};
