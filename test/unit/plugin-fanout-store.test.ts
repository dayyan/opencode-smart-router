import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFanoutStore } from "../../src/plugin/fanout-store";
import { DEFAULT_FANOUT_CONFIG } from "../../src/router/config.types";

// ---------------------------------------------------------------------------
// Fanout containment store — unit tests for createFanoutStore().
//
// Tests the per-plugin-instance state layer: per-tier + global concurrency caps,
// circuit breaker FSM (closed → open → half_open → closed|open), and
// outcome-recording that drives breaker qualification.
//
// The store is plugin-internal until the fanout tool registers in PR 3.
// ---------------------------------------------------------------------------

// Per-test store instance. Not using fake timers for the basic acquire/release
// tests since Date.now() is only called in breaker transitions.
let store: ReturnType<typeof createFanoutStore>;

beforeEach(() => {
  store = createFanoutStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createFanoutStore", () => {
  // -------------------------------------------------------------------------
  // 1. tryAcquire — per-tier cap
  // -------------------------------------------------------------------------

  describe("tryAcquire — per-tier cap", () => {
    it("succeeds up to maxConcurrentPerTier[tier] then rejects with tier_cap", () => {
      const tier = "fast" as const;
      const limit = DEFAULT_FANOUT_CONFIG.maxConcurrentPerTier.fast!;

      for (let i = 0; i < limit; i++) {
        expect(store.tryAcquire(tier).ok).toBe(true);
      }

      const over = store.tryAcquire(tier);
      expect(over.ok).toBe(false);
      expect(over.reason).toBe("tier_cap");
    });

    it("different tiers have independent counters", () => {
      const fastLimit = DEFAULT_FANOUT_CONFIG.maxConcurrentPerTier.fast!;
      const mediumLimit = DEFAULT_FANOUT_CONFIG.maxConcurrentPerTier.medium!;

      for (let i = 0; i < fastLimit; i++) store.tryAcquire("fast");
      expect(store.tryAcquire("fast").ok).toBe(false);

      for (let i = 0; i < mediumLimit; i++) {
        expect(store.tryAcquire("medium").ok).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. tryAcquire — global cap
  // -------------------------------------------------------------------------

  describe("tryAcquire — global cap", () => {
    it("succeeds up to maxConcurrentGlobal then rejects with global_cap", () => {
      const globalLimit = DEFAULT_FANOUT_CONFIG.maxConcurrentGlobal;
      // Exhaust the global cap by filling each tier to its per-tier limit
      // fast=4, light=2, medium=1 = 7 total, but global cap is 6
      expect(store.tryAcquire("fast").ok).toBe(true); // 1
      expect(store.tryAcquire("fast").ok).toBe(true); // 2
      expect(store.tryAcquire("fast").ok).toBe(true); // 3
      expect(store.tryAcquire("fast").ok).toBe(true); // 4 — fast cap
      expect(store.tryAcquire("light").ok).toBe(true); // 5
      expect(store.tryAcquire("light").ok).toBe(true); // 6 — light cap, global exhausted

      // Global cap is hit
      const over = store.tryAcquire("medium");
      expect(over.ok).toBe(false);
      expect(over.reason).toBe("global_cap");
    });
  });

  // -------------------------------------------------------------------------
  // 3. tryAcquire — circuit breaker blocks acquisition
  // -------------------------------------------------------------------------

  describe("tryAcquire — circuit breaker blocks acquisition", () => {
    it("returns circuit_open when breaker is open", () => {
      const { failureThreshold } = DEFAULT_FANOUT_CONFIG.breaker;

      for (let i = 0; i < failureThreshold; i++) {
        store.recordOutcome("timed_out");
      }
      expect(store.breakerState()).toBe("open");

      const result = store.tryAcquire("fast");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("circuit_open");
    });

    it("circuit_open blocks regardless of available cap", () => {
      const { failureThreshold } = DEFAULT_FANOUT_CONFIG.breaker;
      for (let i = 0; i < failureThreshold; i++) store.recordOutcome("timed_out");

      const result = store.tryAcquire("light");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("circuit_open");
    });
  });

  // -------------------------------------------------------------------------
  // 4. release — decrements counters
  // -------------------------------------------------------------------------

  describe("release", () => {
    it("release decrements tier counter; subsequent tryAcquire succeeds", () => {
      const tier = "fast" as const;
      const limit = DEFAULT_FANOUT_CONFIG.maxConcurrentPerTier.fast!;

      for (let i = 0; i < limit; i++) store.tryAcquire(tier);
      expect(store.tryAcquire(tier).ok).toBe(false);

      store.release(tier);

      expect(store.tryAcquire(tier).ok).toBe(true);
    });

    it("release decrements global counter", () => {
      // Fill with mixed tiers to reach global cap (6): fast(4) + light(2)
      const { maxConcurrentPerTier } = DEFAULT_FANOUT_CONFIG;
      for (let i = 0; i < maxConcurrentPerTier.fast!; i++) {
        expect(store.tryAcquire("fast").ok).toBe(true);
      }
      for (let i = 0; i < maxConcurrentPerTier.light!; i++) {
        expect(store.tryAcquire("light").ok).toBe(true);
      }
      // Global cap exhausted
      expect(store.tryAcquire("medium").ok).toBe(false);

      // Release one slot
      store.release("light");

      // Now should be able to acquire again
      expect(store.tryAcquire("light").ok).toBe(true);
    });

    it("release is safe to call more than acquire (idempotent per design)", () => {
      expect(() => store.release("medium")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Breaker FSM — closed → open → half_open → close|open
  // -------------------------------------------------------------------------

  describe("breaker FSM", () => {
    it("starts in closed state", () => {
      expect(store.breakerState()).toBe("closed");
    });

    it("timed_out trips the breaker after failureThreshold consecutive qualifiers", () => {
      const { failureThreshold } = DEFAULT_FANOUT_CONFIG.breaker;

      for (let i = 0; i < failureThreshold - 1; i++) {
        store.recordOutcome("timed_out");
        expect(store.breakerState()).toBe("closed");
      }

      store.recordOutcome("timed_out");
      expect(store.breakerState()).toBe("open");
    });

    it("failed abort trips the breaker (qualifying failure)", () => {
      const { failureThreshold } = DEFAULT_FANOUT_CONFIG.breaker;

      for (let i = 0; i < failureThreshold; i++) {
        store.recordOutcome("failed");
      }
      expect(store.breakerState()).toBe("open");
    });

    it("completed outcome does NOT trip the breaker", () => {
      const { failureThreshold } = DEFAULT_FANOUT_CONFIG.breaker;

      for (let i = 0; i < failureThreshold * 2; i++) {
        store.recordOutcome("completed");
      }
      expect(store.breakerState()).toBe("closed");
    });

    it("cancelled outcome does NOT trip the breaker (non-qualifying)", () => {
      const { failureThreshold } = DEFAULT_FANOUT_CONFIG.breaker;

      for (let i = 0; i < failureThreshold; i++) {
        store.recordOutcome("cancelled");
      }
      expect(store.breakerState()).toBe("closed");
    });

    it("rejected outcome does NOT trip the breaker (non-qualifying)", () => {
      const { failureThreshold } = DEFAULT_FANOUT_CONFIG.breaker;

      for (let i = 0; i < failureThreshold; i++) {
        store.recordOutcome("rejected");
      }
      expect(store.breakerState()).toBe("closed");
    });

    it("breakerState returns half_open after cooldown elapses (lazy transition)", () => {
      // Trip the breaker
      const { failureThreshold, cooldownMs } = DEFAULT_FANOUT_CONFIG.breaker;
      for (let i = 0; i < failureThreshold; i++) store.recordOutcome("timed_out");
      expect(store.breakerState()).toBe("open");

      // Advance fake timers past cooldown
      vi.useFakeTimers();
      vi.advanceTimersByTime(cooldownMs);

      expect(store.breakerState()).toBe("half_open");
    });

    it("first tryAcquire after cooldown transitions to half_open and allows probe", () => {
      const { failureThreshold, cooldownMs } = DEFAULT_FANOUT_CONFIG.breaker;

      for (let i = 0; i < failureThreshold; i++) store.recordOutcome("timed_out");

      vi.useFakeTimers();
      vi.advanceTimersByTime(cooldownMs);

      const probe = store.tryAcquire("fast");
      expect(probe.ok).toBe(true);
      expect(store.breakerState()).toBe("half_open");
    });

    it("half_open — completed outcome closes the breaker", () => {
      const { failureThreshold, cooldownMs } = DEFAULT_FANOUT_CONFIG.breaker;

      for (let i = 0; i < failureThreshold; i++) store.recordOutcome("timed_out");

      vi.useFakeTimers();
      vi.advanceTimersByTime(cooldownMs);
      store.tryAcquire("fast"); // enters half_open
      expect(store.breakerState()).toBe("half_open");

      store.recordOutcome("completed");
      expect(store.breakerState()).toBe("closed");
    });

    it("half_open — qualifying failure (timed_out) re-opens the breaker", () => {
      const { failureThreshold, cooldownMs } = DEFAULT_FANOUT_CONFIG.breaker;

      for (let i = 0; i < failureThreshold; i++) store.recordOutcome("timed_out");

      vi.useFakeTimers();
      vi.advanceTimersByTime(cooldownMs);
      store.tryAcquire("fast"); // half_open
      expect(store.breakerState()).toBe("half_open");

      store.recordOutcome("timed_out");
      expect(store.breakerState()).toBe("open");
    });

    it("half_open — failed outcome also re-opens the breaker", () => {
      const { failureThreshold, cooldownMs } = DEFAULT_FANOUT_CONFIG.breaker;

      for (let i = 0; i < failureThreshold; i++) store.recordOutcome("timed_out");

      vi.useFakeTimers();
      vi.advanceTimersByTime(cooldownMs);
      store.tryAcquire("fast"); // half_open

      store.recordOutcome("failed");
      expect(store.breakerState()).toBe("open");
    });

    it("half_open — subsequent tryAcquire is blocked while probe is in flight", () => {
      const { failureThreshold, cooldownMs } = DEFAULT_FANOUT_CONFIG.breaker;

      for (let i = 0; i < failureThreshold; i++) store.recordOutcome("timed_out");

      vi.useFakeTimers();
      vi.advanceTimersByTime(cooldownMs);
      store.tryAcquire("fast"); // half_open, one probe in flight
      expect(store.breakerState()).toBe("half_open");

      const blocked = store.tryAcquire("fast");
      expect(blocked.ok).toBe(false);
      expect(blocked.reason).toBe("circuit_open");
    });

    it("breakerState is read-only — does not mutate state", () => {
      const state1 = store.breakerState();
      const state2 = store.breakerState();
      expect(state1).toBe(state2);
    });
  });

  // -------------------------------------------------------------------------
  // 6. recordOutcome — qualifying vs non-qualifying edge cases
  // -------------------------------------------------------------------------

  describe("recordOutcome — qualifying vs non-qualifying", () => {
    it("mixed qualifying + non-qualifying: only qualifying accumulate", () => {
      const { failureThreshold } = DEFAULT_FANOUT_CONFIG.breaker;

      // Non-qualifying don't count toward threshold
      for (let i = 0; i < failureThreshold - 1; i++) {
        store.recordOutcome("timed_out");
        store.recordOutcome("completed"); // doesn't help
        store.recordOutcome("cancelled"); // doesn't help
        store.recordOutcome("rejected"); // doesn't help
      }
      expect(store.breakerState()).toBe("closed");
    });

    it("completed does not break the failure streak", () => {
      const { failureThreshold } = DEFAULT_FANOUT_CONFIG.breaker;

      // Interleaving completed doesn't prevent tripping
      for (let i = 0; i < failureThreshold * 2; i++) {
        store.recordOutcome("timed_out");
        store.recordOutcome("completed");
      }
      expect(store.breakerState()).toBe("open");
    });
  });

  // -------------------------------------------------------------------------
  // 7. tryAcquire return shape on success
  // -------------------------------------------------------------------------

  describe("tryAcquire return shape", () => {
    it("returns { ok: true, reason: undefined } on success", () => {
      const result = store.tryAcquire("fast");
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("returns { ok: false, reason: 'tier_cap' } when tier cap is hit", () => {
      const tier = "fast" as const;
      const limit = DEFAULT_FANOUT_CONFIG.maxConcurrentPerTier.fast!;
      for (let i = 0; i < limit; i++) store.tryAcquire(tier);
      const result = store.tryAcquire(tier);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("tier_cap");
    });

    it("returns { ok: false, reason: 'global_cap' } when global cap is hit", () => {
      // Exhaust global cap (6) using mixed tiers: fast(4) + light(2) = 6
      const { maxConcurrentPerTier } = DEFAULT_FANOUT_CONFIG;
      for (let i = 0; i < maxConcurrentPerTier.fast!; i++) {
        expect(store.tryAcquire("fast").ok).toBe(true);
      }
      for (let i = 0; i < maxConcurrentPerTier.light!; i++) {
        expect(store.tryAcquire("light").ok).toBe(true);
      }
      // Now global cap is exhausted (6), next acquisition should fail
      const result = store.tryAcquire("medium");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("global_cap");
    });

    it("returns { ok: false, reason: 'circuit_open' } when breaker is open", () => {
      const { failureThreshold } = DEFAULT_FANOUT_CONFIG.breaker;
      for (let i = 0; i < failureThreshold; i++) store.recordOutcome("timed_out");
      const result = store.tryAcquire("fast");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("circuit_open");
    });
  });
});
