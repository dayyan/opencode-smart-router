// ---------------------------------------------------------------------------
// test/unit/fanout-config-defaults.test.ts
//
// Verifies DEFAULT_FANOUT_CONFIG matches the plan's required defaults byte-for-byte.
// This is a pure constant test — no runtime behavior involved.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

// The constant is imported from config.types after implementation.
import { DEFAULT_FANOUT_CONFIG } from "../../src/router/config.types";

describe("DEFAULT_FANOUT_CONFIG", () => {
  it("matches plan defaults byte-for-byte", () => {
    expect(DEFAULT_FANOUT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_FANOUT_CONFIG.maxWorkersPerBatch).toBe(4);
    expect(DEFAULT_FANOUT_CONFIG.maxConcurrentGlobal).toBe(6);
    expect(DEFAULT_FANOUT_CONFIG.maxConcurrentPerTier).toEqual({
      fast: 4,
      light: 2,
      medium: 1,
    });
    expect(DEFAULT_FANOUT_CONFIG.workerTimeoutMs).toBe(120000);
    expect(DEFAULT_FANOUT_CONFIG.batchTimeoutMs).toBe(180000);
    expect(DEFAULT_FANOUT_CONFIG.breaker).toEqual({
      failureThreshold: 3,
      cooldownMs: 60000,
    });
  });

  it("breaker sub-object has correct structure", () => {
    // breaker is a shared frozen constant object (standard config pattern)
    expect(DEFAULT_FANOUT_CONFIG.breaker.failureThreshold).toBe(3);
    expect(DEFAULT_FANOUT_CONFIG.breaker.cooldownMs).toBe(60000);
  });
});
