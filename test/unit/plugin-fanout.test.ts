import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../src/plugin/context";
import { createFanoutStore } from "../../src/plugin/fanout-store";
import { createReasoningStore } from "../../src/reasoning/store";
import type { RouterConfig } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Fanout admission contract tests.
//
// Tests exercise the admission gate of `executeFanout` in the stub阶段.
// The stub implements the admission gate (depth/tier/producer/grader/worker/
// breaker/empty checks) and returns a typed `rejected` aggregate for every
// non-passing case. All tests assert that SDK calls (session.create) are NEVER
// made when the admission gate rejects.
//
// PR 3a: stub executor only — real executor is PR 3b.
// ---------------------------------------------------------------------------

// executeFanout is imported inside each test (deferred import for RED phase)

let tmpHome: string;
let tmpCwd: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origCwd: string;

beforeEach(() => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  origCwd = process.cwd();

  tmpHome = join(
    tmpdir(),
    `oc-fanout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
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
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Fake PluginContext builder — mirrors plugin-delegate.test.ts makeCtx pattern.
// ---------------------------------------------------------------------------

interface SessionCall {
  sessionID: string;
  promptText?: string;
}

const makeCtx = (opts: {
  callerSid?: string;
  callerDepth?: number;
  callerTier?: string;
  isProducer?: boolean;
  isGrader?: boolean;
  isFanoutWorker?: boolean;
  fanoutEnabled?: boolean;
  breakerState?: "closed" | "open" | "half_open";
  createImpl?: (req: any) => Promise<any>;
  promptImpl?: (req: any) => Promise<any>;
  abortImpl?: (req: any) => Promise<any>;
  deleteImpl?: (req: any) => Promise<any>;
}): {
  ctx: PluginContext;
  sessions: SessionCall[];
  createSpy: ReturnType<typeof vi.fn>;
} => {
  const sessions: SessionCall[] = [];
  let createSeq = 0;
  const createSpy = vi.fn().mockImplementation(
    opts.createImpl ??
      (async () => {
        const id = `sess_${++createSeq}`;
        sessions.push({ sessionID: id });
        return { data: { id } };
      }),
  );

  const baseConfig: RouterConfig = {
    activePreset: "default",
    defaultTier: "fast",
    presets: {
      default: {
        fast: {
          model: "anthropic/claude-haiku-4-5",
          description: "fast",
          whenToUse: [],
          costRatio: 1,
        },
        light: {
          model: "anthropic/claude-haiku-4-5",
          description: "light",
          whenToUse: [],
          costRatio: 1,
        },
        medium: {
          model: "anthropic/claude-sonnet-4",
          description: "medium",
          whenToUse: [],
          costRatio: 3,
        },
        heavy: {
          model: "anthropic/claude-opus-4",
          description: "heavy",
          whenToUse: [],
          costRatio: 9,
        },
      },
    },
    rules: [],
    fanout: {
      enabled: opts.fanoutEnabled ?? true,
      maxWorkersPerBatch: 4,
      maxConcurrentGlobal: 6,
      maxConcurrentPerTier: { fast: 4, light: 2, medium: 1 },
      workerTimeoutMs: 120000,
      batchTimeoutMs: 180000,
      breaker: { failureThreshold: 3, cooldownMs: 60000 },
    },
  };

  const callerSid = opts.callerSid ?? "caller-sid-1";
  const callerDepth = opts.callerDepth ?? 1;
  const callerTier = opts.callerTier ?? "medium";

  const fanoutStore = createFanoutStore();
  // Set breaker state if needed
  if (opts.breakerState === "open") {
    // Trip the breaker
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
          prompt:
            opts.promptImpl ??
            (async (req: any) => {
              const id = req?.path?.id ?? "?";
              const text = req?.body?.parts?.[0]?.text ?? "(no text)";
              const last = sessions.find((s) => s.sessionID === id);
              if (last) last.promptText = text;
              return { data: { parts: [{ type: "text", text: "done." }] } };
            }),
          abort: opts.abortImpl ?? vi.fn().mockResolvedValue(undefined),
          delete: opts.deleteImpl ?? vi.fn().mockResolvedValue(undefined),
        },
      },
    } as any,
    initialConfig: baseConfig,
    activeTiersAtLoad: baseConfig.presets["default"]!,
    getConfig: async () => baseConfig,
    refreshConfig: async () => baseConfig,
    async getFreshConfig() {
      return baseConfig;
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

  return { ctx, sessions, createSpy };
};

// ---------------------------------------------------------------------------
// Helper: call executeFanout with given args and callerSid
// ---------------------------------------------------------------------------

// We need to import executeFanout from fanout.ts but it doesn't exist yet.
// For RED phase, we write tests that reference the module that will exist.

const importExecuteFanout = async () => {
  const mod = await import("../../src/plugin/fanout");
  return mod.executeFanout;
};

// ---------------------------------------------------------------------------
// Test: Policy matrix — denied edges
// ---------------------------------------------------------------------------

describe("executeFanout — policy matrix denied edges", () => {
  it("fast caller → rejected, no SDK calls", async () => {
    const { ctx, createSpy } = makeCtx({ callerTier: "fast", callerDepth: 1 });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("light caller → rejected, no SDK calls", async () => {
    const { ctx, createSpy } = makeCtx({ callerTier: "light", callerDepth: 1 });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("medium caller → light worker rejected (medium→light not allowed)", async () => {
    const { ctx, createSpy } = makeCtx({ callerTier: "medium", callerDepth: 1 });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "light", prompt: "do work" }] },
      "caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("medium caller → medium worker rejected (medium→medium not allowed)", async () => {
    const { ctx, createSpy } = makeCtx({ callerTier: "medium", callerDepth: 1 });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "medium", prompt: "do work" }] },
      "caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("focused caller → heavy worker rejected (focused→heavy not allowed)", async () => {
    const { ctx, createSpy } = makeCtx({ callerTier: "heavy", callerDepth: 1 });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "heavy", prompt: "do work" }] },
      "caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("heavy caller → heavy worker rejected (heavy→heavy not allowed)", async () => {
    const { ctx, createSpy } = makeCtx({ callerTier: "heavy", callerDepth: 1 });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "heavy", prompt: "do work" }] },
      "caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test: Eligibility rules
// ---------------------------------------------------------------------------

describe("executeFanout — eligibility rules", () => {
  it("depth-0 orchestrator → rejected", async () => {
    const { ctx, createSpy } = makeCtx({ callerDepth: 0, callerTier: "medium" });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "orchestrator-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("depth-2 grandchild → rejected", async () => {
    const { ctx, createSpy } = makeCtx({ callerDepth: 2, callerTier: "heavy" });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "grandchild-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("caller is a producer session → rejected", async () => {
    const { ctx, createSpy } = makeCtx({ callerDepth: 1, callerTier: "heavy", isProducer: true });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "producer-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("caller is a grader session → rejected", async () => {
    const { ctx, createSpy } = makeCtx({ callerDepth: 1, callerTier: "heavy", isGrader: true });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "grader-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("caller is a fanout worker → rejected", async () => {
    const { ctx, createSpy } = makeCtx({
      callerDepth: 1,
      callerTier: "heavy",
      isFanoutWorker: true,
    });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "worker-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("fresh cfg.fanout.enabled === false → rejected (kill switch)", async () => {
    const { ctx, createSpy } = makeCtx({
      callerDepth: 1,
      callerTier: "heavy",
      fanoutEnabled: false,
    });
    const executeFanout = await importExecuteFanout();
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
    const executeFanout = await importExecuteFanout();
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

// ---------------------------------------------------------------------------
// Test: Empty batch
// ---------------------------------------------------------------------------

describe("executeFanout — empty batch (engram #4963)", () => {
  it("items: [] → typed rejected, zero SDK calls", async () => {
    const { ctx, createSpy } = makeCtx({ callerDepth: 1, callerTier: "heavy" });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(ctx, { items: [] }, "caller-sid", undefined as any);
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test: Tool registration (handled separately in plugin-runtime tests)
// ---------------------------------------------------------------------------

describe("executeFanout — stub behavior (allowed edge)", () => {
  it("all eligibility checks pass → stub returns typed rejected (real executor is PR 3b)", async () => {
    const { ctx, createSpy } = makeCtx({
      callerDepth: 1,
      callerTier: "heavy",
      fanoutEnabled: true,
    });
    const executeFanout = await importExecuteFanout();
    // All gates pass for heavy→fast (allowed edge)
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "heavy-caller-sid",
      undefined as any,
    );
    // Stub returns rejected because real executor is PR 3b
    expect(out).toContain("rejected");
    // No SDK calls because stub immediately returns rejected
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("medium→fast allowed edge → stub returns rejected", async () => {
    const { ctx, createSpy } = makeCtx({
      callerDepth: 1,
      callerTier: "medium",
      fanoutEnabled: true,
    });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "medium-caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("focused→fast allowed edge → stub returns rejected", async () => {
    const { ctx, createSpy } = makeCtx({
      callerDepth: 1,
      callerTier: "heavy", // heavy has same allowlist as focused
      fanoutEnabled: true,
    });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "fast", prompt: "do work" }] },
      "focused-caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("focused→light allowed edge → stub returns rejected", async () => {
    const { ctx, createSpy } = makeCtx({
      callerDepth: 1,
      callerTier: "heavy",
      fanoutEnabled: true,
    });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "light", prompt: "do work" }] },
      "focused-caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("focused→medium allowed edge → stub returns rejected", async () => {
    const { ctx, createSpy } = makeCtx({
      callerDepth: 1,
      callerTier: "heavy",
      fanoutEnabled: true,
    });
    const executeFanout = await importExecuteFanout();
    const out = await executeFanout(
      ctx,
      { items: [{ tier: "medium", prompt: "do work" }] },
      "focused-caller-sid",
      undefined as any,
    );
    expect(out).toContain("rejected");
    expect(createSpy).not.toHaveBeenCalled();
  });
});
