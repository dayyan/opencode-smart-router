import { describe, it, expect } from "vitest";
import {
  buildGuardPolicy,
  evaluateGuards,
  guardBeforeCall,
  newGuardState,
  updateState,
} from "../../src/guard/Guard.res.mjs";
import type { RouterConfig } from "../../src/router/config";
import { resolveEnforcementMode } from "../../src/router/enforcement";

const cfg = (enforcement?: RouterConfig["enforcement"]): RouterConfig => {
  return {
    activePreset: "default",
    presets: {},
    rules: [],
    defaultTier: "fast",
    enforcement,
  } as RouterConfig;
};

const makeStore = () => ({
  ensure: (_sessionID: string, policy: Parameters<typeof newGuardState>[0]) =>
    newGuardState(policy),
  get: () => undefined,
  setPendingNote: () => {},
  takePendingNote: () => undefined,
});

const resolveWithGuard = (params: {
  config: RouterConfig;
  tier?: string;
  env: Record<string, string | undefined>;
}) => {
  const env = Object.fromEntries(
    Object.entries(params.env).map(([key, value]) => [key, value ?? null]),
  );

  return guardBeforeCall({
    cfg: params.config,
    tier: params.tier ?? null,
    sessionID: "parity-session",
    tool: "read",
    toolArgs: { file_path: "parity.md" },
    store: makeStore(),
    env,
    trivial: false,
  });
};

describe("guard resolver mode parity", () => {
  const cases: Array<{
    name: string;
    enforcement?: RouterConfig["enforcement"];
    tier?: string;
    env: Record<string, string | undefined>;
    expected: "off" | "advisory" | "enforced";
  }> = [
    {
      name: 'env gate "1" enforces',
      enforcement: { mode: "off" },
      env: { MODEL_ROUTER_ENFORCE: "1" },
      expected: "enforced",
    },
    {
      name: 'env gate "0" disables',
      enforcement: { mode: "enforced" },
      env: { MODEL_ROUTER_ENFORCE: "0" },
      expected: "off",
    },
    {
      name: "unset env gate uses advisory default",
      enforcement: undefined,
      env: {},
      expected: "advisory",
    },
    {
      name: "unrecognized env gate falls back to config",
      enforcement: { mode: "off" },
      env: { MODEL_ROUTER_ENFORCE: "maybe" },
      expected: "off",
    },
    {
      name: "custom env gate is honored",
      enforcement: { mode: "off", envGate: "MY_GATE" },
      env: { MY_GATE: "1" },
      expected: "enforced",
    },
    {
      name: "configured enforced mode is used without env override",
      enforcement: { mode: "enforced" },
      env: {},
      expected: "enforced",
    },
    {
      name: "per-tier mode overrides the base mode",
      enforcement: { mode: "off", perTier: { heavy: "enforced" } },
      tier: "heavy",
      env: {},
      expected: "enforced",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const config = cfg(testCase.enforcement);
      const tsResult = resolveEnforcementMode({
        config,
        tier: testCase.tier,
        env: testCase.env,
      });
      const guardResult = resolveWithGuard({
        config,
        tier: testCase.tier,
        env: testCase.env,
      });

      expect(tsResult.mode).toBe(testCase.expected);
      expect(guardResult.mode).toBe(tsResult.mode);
    });
  }
});

describe("guard resolver warning parity", () => {
  it("returns the documented warning for an unrecognized env value", () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "advisory" }),
      env: { MODEL_ROUTER_ENFORCE: "maybe" },
    });

    expect(result.warning).toBe(
      'MODEL_ROUTER_ENFORCE="maybe" is not "1" or "0"; ignoring env gate and using config.',
    );
  });
});

describe("guard fingerprint empty-string semantics", () => {
  it("treats repeated reads with an empty file path as redundant", () => {
    const policy = buildGuardPolicy(
      { enforcement: { guard: { deliverableFirst: false } } },
      null,
    );
    const state = newGuardState(policy);
    const call = { tool: "read", args: { file_path: "" } };

    const first = evaluateGuards(state, call, policy);
    expect(first.guard).toBeNull();
    updateState(state, call, { ok: true }, policy);

    const second = evaluateGuards(state, call, policy);
    expect(second.guard).toBe("redundant_read");
  });
});
