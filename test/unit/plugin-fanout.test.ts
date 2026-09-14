import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../src/plugin/context";
import { createFanoutStore } from "../../src/plugin/fanout-store";
import { createReasoningStore } from "../../src/reasoning/store";
import type { RouterConfig } from "../../src/router/config";

const BASE_CONFIG: RouterConfig = {
  activePreset: "default",
  defaultTier: "fast",
  presets: {
    default: {
      fast: { model: "a", description: "f", whenToUse: [], costRatio: 1 },
      light: { model: "a", description: "l", whenToUse: [], costRatio: 1 },
      medium: { model: "b", description: "m", whenToUse: [], costRatio: 3 },
      heavy: { model: "c", description: "h", whenToUse: [], costRatio: 9 },
    },
  },
  rules: [],
  fanout: {
    enabled: true,
    maxWorkersPerBatch: 4,
    maxConcurrentGlobal: 6,
    maxConcurrentPerTier: { fast: 4, light: 2, medium: 1 },
    workerTimeoutMs: 120000,
    batchTimeoutMs: 180000,
    breaker: { failureThreshold: 3, cooldownMs: 60000 },
  },
};

let tmpHome: string;
let tmpCwd: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origCwd: string;

beforeEach(() => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  origCwd = process.cwd();
  tmpHome = join(tmpdir(), `oc-fanout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  tmpCwd = join(tmpHome, "cwd");
  mkdirSync(tmpCwd, { recursive: true });
  process.chdir(tmpCwd);
});

afterEach(() => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
  process.chdir(origCwd);
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const makeCtx = (opts: {
  callerSid?: string;
  callerDepth?: number;
  callerTier?: string;
  isProducer?: boolean;
  isGrader?: boolean;
  isFanoutWorker?: boolean;
  fanoutEnabled?: boolean;
  breakerState?: "closed" | "open" | "half_open";
}) => {
  const createSpy = vi.fn().mockResolvedValue({ data: { id: "sess_1" } });
  const cfg: RouterConfig = {
    ...BASE_CONFIG,
    fanout: { ...BASE_CONFIG.fanout, enabled: opts.fanoutEnabled ?? true },
  };
  const callerSid = opts.callerSid ?? "caller-sid-1";
  const callerDepth = opts.callerDepth ?? 1;
  const callerTier = opts.callerTier ?? "medium";
  const fanoutStore = createFanoutStore();
  if (opts.breakerState === "open") {
    fanoutStore.recordOutcome("failed");
    fanoutStore.recordOutcome("failed");
    fanoutStore.recordOutcome("failed");
  }
  const ctx: PluginContext = {
    plugin: {
      directory: tmpCwd,
      client: {
        session: {
          create: createSpy,
          prompt: async () => ({ data: { parts: [{ type: "text", text: "done." }] } }),
          abort: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        },
      },
    } as any,
    initialConfig: cfg,
    activeTiersAtLoad: cfg.presets["default"]!,
    getConfig: async () => cfg,
    refreshConfig: async () => cfg,
    async getFreshConfig() {
      return cfg;
    },
    dispose: async () => {},
    state: { bypassed: false, cleanupTasks: [], shutdownStarted: false },
    sessionStore: {
      registerProducerSession: () => undefined,
      unregister: () => undefined,
      isSubagent: () => false,
      isTrivial: () => false,
      getTier: () => callerTier,
      registerFromChatMessage: () => undefined,
      recordToolCall: () => undefined,
      depth: (sid: string) => (sid === callerSid ? callerDepth : 0),
      parentOf: () => null,
      isDescendant: (sid: string) => sid !== callerSid && callerDepth >= 1,
      markFanoutWorker: vi.fn(),
      isFanoutWorker: (sid: string) => (opts.isFanoutWorker ? sid === callerSid : false),
      isProducerSession: (sid: string) => (opts.isProducer ? sid === callerSid : false),
    } as any,
    trajectoryStore: {
      ensure: () => undefined,
      recordToolEvent: () => undefined,
      dump: () => null,
    } as any,
    guardStore: { get: () => null, clear: () => undefined } as any,
    changedFileStore: { get: () => [], clear: () => undefined, record: () => undefined } as any,
    reasoningStore: createReasoningStore(),
    graderSessions: opts.isGrader ? new Set([callerSid]) : new Set<string>(),
    verifyMutex: {} as any,
    seams: { exec: {} as any, fs: {} as any },
    fanoutStore,
  };
  return { ctx, createSpy };
};

describe("executeFanout — policy matrix denied edges", () => {
  const cases = [
    { callerTier: "fast", workerTier: "fast", label: "fast caller" },
    { callerTier: "light", workerTier: "fast", label: "light caller" },
    { callerTier: "medium", workerTier: "light", label: "medium→light" },
    { callerTier: "medium", workerTier: "medium", label: "medium→medium" },
    { callerTier: "heavy", workerTier: "heavy", label: "heavy→heavy" },
    { callerTier: "focused", workerTier: "heavy", label: "focused→heavy" },
  ];
  for (const { callerTier, workerTier, label } of cases) {
    it(`${label} → rejected, no SDK calls`, async () => {
      const { ctx, createSpy } = makeCtx({
        callerTier: callerTier as "medium" | "heavy" | "focused",
        callerDepth: 1,
      });
      const { executeFanout } = await import("../../src/plugin/fanout");
      const out = await executeFanout(
        ctx,
        { items: [{ tier: workerTier, prompt: "do work" }] },
        "caller-sid",
        undefined as any,
      );
      expect(out).toContain("rejected");
      expect(createSpy).not.toHaveBeenCalled();
    });
  }
});

describe("executeFanout — eligibility rules", () => {
  const cases = [
    {
      depth: 0,
      tier: "medium",
      label: "depth-0 orchestrator",
      isGrader: false,
      isProducer: false,
      isFanoutWorker: false,
    },
    {
      depth: 2,
      tier: "heavy",
      label: "depth-2 grandchild",
      isGrader: false,
      isProducer: false,
      isFanoutWorker: false,
    },
    {
      depth: 1,
      tier: "heavy",
      label: "producer session",
      isGrader: false,
      isProducer: true,
      isFanoutWorker: false,
    },
    {
      depth: 1,
      tier: "heavy",
      label: "grader session",
      isGrader: true,
      isProducer: false,
      isFanoutWorker: false,
    },
    {
      depth: 1,
      tier: "heavy",
      label: "fanout worker",
      isGrader: false,
      isProducer: false,
      isFanoutWorker: true,
    },
  ];
  for (const { depth, tier, label, isGrader, isProducer, isFanoutWorker } of cases) {
    it(`${label} → rejected`, async () => {
      const { ctx, createSpy } = makeCtx({
        callerDepth: depth,
        callerTier: tier as "medium" | "heavy" | "focused",
        isGrader,
        isProducer,
        isFanoutWorker,
      });
      const { executeFanout } = await import("../../src/plugin/fanout");
      const out = await executeFanout(
        ctx,
        { items: [{ tier: "fast", prompt: "do work" }] },
        "caller-sid",
        undefined as any,
      );
      expect(out).toContain("rejected");
      expect(createSpy).not.toHaveBeenCalled();
    });
  }
  it("kill switch disabled → rejected", async () => {
    const { ctx, createSpy } = makeCtx({
      callerDepth: 1,
      callerTier: "heavy",
      fanoutEnabled: false,
    });
    const { executeFanout } = await import("../../src/plugin/fanout");
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });
  it("breaker open → rejected", async () => {
    const { ctx, createSpy } = makeCtx({
      callerDepth: 1,
      callerTier: "heavy",
      breakerState: "open",
    });
    const { executeFanout } = await import("../../src/plugin/fanout");
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("executeFanout — empty batch (engram #4963)", () => {
  it("items: [] → typed rejected, zero SDK calls", async () => {
    const { ctx, createSpy } = makeCtx({ callerDepth: 1, callerTier: "heavy" });
    const { executeFanout } = await import("../../src/plugin/fanout");
    const out = await executeFanout(ctx, { items: [] }, "caller-sid", undefined as any);
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("executeFanout — stub behavior", () => {
  const cases = [
    { callerTier: "heavy", workerTier: "fast", label: "heavy→fast" },
    { callerTier: "medium", workerTier: "fast", label: "medium→fast" },
    { callerTier: "heavy", workerTier: "light", label: "heavy→light" },
    { callerTier: "heavy", workerTier: "medium", label: "heavy→medium" },
  ];
  for (const { callerTier, workerTier, label } of cases) {
    it(`${label} → stub returns rejected`, async () => {
      const { ctx, createSpy } = makeCtx({
        callerDepth: 1,
        callerTier: callerTier as "medium" | "heavy",
        fanoutEnabled: true,
      });
      const { executeFanout } = await import("../../src/plugin/fanout");
      const out = await executeFanout(
        ctx,
        { items: [{ tier: workerTier, prompt: "do work" }] },
        "caller-sid",
        undefined as any,
      );
      expect(out).toContain("rejected");
      expect(createSpy).not.toHaveBeenCalled();
    });
  }
});
