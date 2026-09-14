import { describe, expect, it } from "vitest";
import type { PluginContext } from "../../src/plugin/context";
import { createFanoutStore } from "../../src/plugin/fanout-store";
import { handleToolExecuteBefore } from "../../src/plugin/hooks";
import { createReasoningStore } from "../../src/reasoning/store";
import { createSessionStore } from "../../src/router/sessions";

// ---------------------------------------------------------------------------
// Integration test: real store + real hook wiring for depth-based guard.
//
// Uses the real createSessionStore() (not a mock) to prove the
// store→handler wiring from session.created through handleToolExecuteBefore.
// This is the test that proves the real end-to-end path, complementing the
// mock-based unit tests in plugin-hooks.test.ts.
// ---------------------------------------------------------------------------

const makeRealHarness = () => {
  const sessionStore = createSessionStore();
  const reasoningStore = createReasoningStore();
  const fanoutStore = createFanoutStore();

  const ctx = {
    plugin: { directory: "/tmp", client: {} as any } as any,
    initialConfig: {
      activePreset: "default",
      defaultTier: "fast",
      presets: {
        default: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "fast",
            whenToUse: [],
          },
          medium: {
            model: "anthropic/claude-sonnet-4-6",
            description: "medium",
            whenToUse: [],
          },
          light: {
            model: "anthropic/claude-haiku-4-5",
            description: "light",
            whenToUse: [],
          },
          focused: {
            model: "anthropic/claude-sonnet-4-6",
            description: "focused",
            whenToUse: [],
          },
          heavy: {
            model: "anthropic/claude-opus-4-8",
            description: "heavy",
            whenToUse: [],
          },
        },
      },
      rules: [],
      enforcement: { verify: { graderTemperature: 0 } },
      fanout: {
        enabled: true,
        maxConcurrentGlobal: 10,
        maxConcurrentPerTier: { fast: 5, light: 5, medium: 5 },
        batchTimeoutMs: 30000,
        workerTimeoutMs: 15000,
        breaker: { failureThreshold: 5, cooldownMs: 60000 },
      },
    } as any,
    activeTiersAtLoad: {
      fast: {
        model: "anthropic/claude-haiku-4-5",
        description: "fast",
        whenToUse: [],
      },
      medium: {
        model: "anthropic/claude-sonnet-4-6",
        description: "medium",
        whenToUse: [],
      },
      light: {
        model: "anthropic/claude-haiku-4-5",
        description: "light",
        whenToUse: [],
      },
      focused: {
        model: "anthropic/claude-sonnet-4-6",
        description: "focused",
        whenToUse: [],
      },
      heavy: {
        model: "anthropic/claude-opus-4-8",
        description: "heavy",
        whenToUse: [],
      },
    } as any,
    getConfig: async () => ctx.initialConfig,
    refreshConfig: async () => ctx.initialConfig,
    getFreshConfig: async () => ctx.initialConfig,
    dispose: async () => {},
    state: { bypassed: false, cleanupTasks: [], shutdownStarted: false },
    sessionStore,
    fanoutStore,
    trajectoryStore: {
      ensure: () => {},
      recordToolEvent: () => {},
      dump: () => null,
    },
    guardStore: { get: () => null, clear: () => {} },
    changedFileStore: { record: () => {}, get: () => [], clear: () => {} },
    reasoningStore,
    graderSessions: new Set<string>(),
    verifyMutex: {} as any,
    seams: { exec: {} as any, fs: {} as any },
    opencodeConfig: {
      agent: {
        fast: {
          model: "anthropic/claude-haiku-4-5",
          mode: "subagent",
          description: "fast",
          prompt: "test",
          variant: "low",
        },
        medium: {
          model: "anthropic/claude-sonnet-4-6",
          mode: "subagent",
          description: "medium",
          prompt: "test",
          variant: "medium",
        },
        light: {
          model: "anthropic/claude-haiku-4-5",
          mode: "subagent",
          description: "light",
          prompt: "test",
          variant: "low",
        },
        focused: {
          model: "anthropic/claude-sonnet-4-6",
          mode: "subagent",
          description: "focused",
          prompt: "test",
          variant: "medium",
        },
        heavy: {
          model: "anthropic/claude-opus-4-8",
          mode: "subagent",
          description: "heavy",
          prompt: "test",
          variant: "high",
        },
      },
    },
  } as unknown as PluginContext;

  return { ctx, sessionStore, fanoutStore };
};

describe("nested-delegation-guard — real store + real hook wiring", () => {
  it("depth-1 child task is blocked by the depth guard", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    // 1) session.created fires for the orchestrator's child session.
    sessionStore.registerFromSessionCreated({ sessionID: "sid-child", parentID: "sid-orch" });

    // The child is not a subagent per se (not registered via chat.message or
    // delegate), but it is a descendant (depth >= 1). The depth guard checks
    // isDescendant() which uses depth() — verify depth is 1.
    expect(sessionStore.depth("sid-child")).toBe(1);
    expect(sessionStore.isDescendant("sid-child")).toBe(true);

    // 2) The child tries to call "task" — this must be blocked.
    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-child", tool: "task", args: { subagent_type: "fast" } },
        { args: { subagent_type: "fast" } },
      ),
    ).rejects.toThrow(/Nested subagent delegation is not allowed/);
  });

  it("depth-1 child delegate is blocked by the depth guard", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    sessionStore.registerFromSessionCreated({ sessionID: "sid-child", parentID: "sid-orch" });
    expect(sessionStore.depth("sid-child")).toBe(1);

    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-child", tool: "delegate", args: { task: "do work" } },
        { args: { task: "do work" } },
      ),
    ).rejects.toThrow(/Nested subagent delegation is not allowed/);
  });

  it("depth-0 orchestrator task is NOT blocked", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    // Orchestrator has no parent (root session).
    sessionStore.registerFromSessionCreated({ sessionID: "sid-orch", parentID: null as any });
    expect(sessionStore.depth("sid-orch")).toBe(0);
    expect(sessionStore.isDescendant("sid-orch")).toBe(false);

    // Orchestrator calling task is fine (reasoning-patch path runs).
    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-orch", tool: "task", args: { subagent_type: "fast" } },
        { args: { subagent_type: "fast" } },
      ),
    ).resolves.toBeUndefined();
  });

  it("depth-2 grandchild task is blocked", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    sessionStore.registerFromSessionCreated({ sessionID: "sid-child", parentID: "sid-orch" });
    sessionStore.registerFromSessionCreated({ sessionID: "sid-grandchild", parentID: "sid-child" });
    expect(sessionStore.depth("sid-grandchild")).toBe(2);
    expect(sessionStore.isDescendant("sid-grandchild")).toBe(true);

    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-grandchild", tool: "task", args: { subagent_type: "fast" } },
        { args: { subagent_type: "fast" } },
      ),
    ).rejects.toThrow(/Nested subagent delegation is not allowed/);
  });

  it("depth-1 child read-only tool is NOT blocked", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    sessionStore.registerFromSessionCreated({ sessionID: "sid-child", parentID: "sid-orch" });
    expect(sessionStore.depth("sid-child")).toBe(1);

    // Read-only tools pass through to guardBeforeCall (not blocked by depth guard).
    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-child", tool: "read", args: { file_path: "a.ts" } },
        { args: { file_path: "a.ts" } },
      ),
    ).resolves.toBeUndefined();
  });

  it("unregister clears depth tracking: child is not a descendant after unregister", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    sessionStore.registerFromSessionCreated({ sessionID: "sid-child", parentID: "sid-orch" });
    expect(sessionStore.depth("sid-child")).toBe(1);
    expect(sessionStore.isDescendant("sid-child")).toBe(true);

    sessionStore.unregister("sid-child");

    // After unregister the session is gone from tracking.
    expect(sessionStore.depth("sid-child")).toBe(0);
    expect(sessionStore.isDescendant("sid-child")).toBe(false);
  });

  it("session.created without parentID: depth 0, not a descendant", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    // A root session (no parentID) — depth 0.
    sessionStore.registerFromSessionCreated({ sessionID: "sid-root", parentID: null as any });
    expect(sessionStore.depth("sid-root")).toBe(0);
    expect(sessionStore.isDescendant("sid-root")).toBe(false);

    // Root session calling task is not blocked.
    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-root", tool: "task", args: { subagent_type: "fast" } },
        { args: { subagent_type: "fast" } },
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fanout policy matrix — guard layer verification.
//
// These tests prove that `fanout` is NOT blocked by the depth/nesting guard
// (assertNestedDelegationAllowed). fanout classifies as "other" in
// src/guard/guards.ts:128 — it is not in task/delegate, so the depth check
// at tool-guards.ts:75-80 passes silently.
//
// The fanout executor applies its own admission policy (caller tier, worker
// marker, producer/grader exclusion, breaker state) in
// src/plugin/fanout.ts:executeFanout — that is unit-tested in
// plugin-fanout.test.ts. These tests verify only the guard layer contract.
// ---------------------------------------------------------------------------

describe("fanout policy matrix — guard layer (handleToolExecuteBefore)", () => {
  it("depth-1 medium caller: fanout is NOT blocked by the depth guard", async () => {
    // D-7 invariant: fanout classifies as "other" (guards.ts:128) and passes
    // through buildGuardPolicy without being added to task/delegate guards.
    // The guard layer must NOT throw for fanout from a depth-1 medium child.
    const { ctx, sessionStore } = makeRealHarness();
    sessionStore.registerFromSessionCreated({
      sessionID: "sid-medium-child",
      parentID: "sid-orch",
    });
    expect(sessionStore.depth("sid-medium-child")).toBe(1);
    expect(sessionStore.isDescendant("sid-medium-child")).toBe(true);

    // Guard layer does NOT block fanout — passes through silently.
    await expect(
      handleToolExecuteBefore(
        ctx,
        {
          sessionID: "sid-medium-child",
          tool: "fanout",
          args: { items: [{ tier: "fast", prompt: "grep for auth" }] },
        },
        { args: { items: [{ tier: "fast", prompt: "grep for auth" }] } },
      ),
    ).resolves.toBeUndefined();
  });

  it("depth-1 fast caller: fanout is NOT blocked by the depth guard (task/delegate still blocked)", async () => {
    // fanout is not task/delegate — guard layer lets it through.
    // Existing task/delegate blocks remain in place.
    const { ctx, sessionStore } = makeRealHarness();
    sessionStore.registerFromSessionCreated({ sessionID: "sid-fast-child", parentID: "sid-orch" });
    expect(sessionStore.depth("sid-fast-child")).toBe(1);

    // fanout passes through guard layer for fast callers too.
    await expect(
      handleToolExecuteBefore(
        ctx,
        {
          sessionID: "sid-fast-child",
          tool: "fanout",
          args: { items: [{ tier: "fast", prompt: "grep" }] },
        },
        { args: { items: [{ tier: "fast", prompt: "grep" }] } },
      ),
    ).resolves.toBeUndefined();

    // task and delegate are still blocked for depth-1 fast sessions.
    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-fast-child", tool: "task", args: { subagent_type: "fast" } },
        { args: { subagent_type: "fast" } },
      ),
    ).rejects.toThrow(/Nested subagent delegation is not allowed/);

    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-fast-child", tool: "delegate", args: { task: "do work" } },
        { args: { task: "do work" } },
      ),
    ).rejects.toThrow(/Nested subagent delegation is not allowed/);
  });

  it("depth-1 light caller: fanout is NOT blocked by the depth guard (task/delegate still blocked)", async () => {
    const { ctx, sessionStore } = makeRealHarness();
    sessionStore.registerFromSessionCreated({ sessionID: "sid-light-child", parentID: "sid-orch" });
    expect(sessionStore.depth("sid-light-child")).toBe(1);

    // fanout passes through guard layer.
    await expect(
      handleToolExecuteBefore(
        ctx,
        {
          sessionID: "sid-light-child",
          tool: "fanout",
          args: { items: [{ tier: "fast", prompt: "search" }] },
        },
        { args: { items: [{ tier: "fast", prompt: "search" }] } },
      ),
    ).resolves.toBeUndefined();

    // task/delegate remain blocked.
    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-light-child", tool: "task", args: { subagent_type: "fast" } },
        { args: { subagent_type: "fast" } },
      ),
    ).rejects.toThrow(/Nested subagent delegation is not allowed/);
  });

  it("depth-1 fanout worker caller: fanout is NOT blocked by the depth guard", async () => {
    // fanout workers are depth-1 but marked; the guard layer itself does not
    // block fanout — the executor's admission logic handles worker exclusion.
    const { ctx, sessionStore } = makeRealHarness();
    sessionStore.registerFromSessionCreated({ sessionID: "sid-worker", parentID: "sid-orch" });
    sessionStore.markFanoutWorker("sid-worker");
    expect(sessionStore.depth("sid-worker")).toBe(1);
    expect(sessionStore.isFanoutWorker("sid-worker")).toBe(true);

    await expect(
      handleToolExecuteBefore(
        ctx,
        {
          sessionID: "sid-worker",
          tool: "fanout",
          args: { items: [{ tier: "fast", prompt: "nested fanout" }] },
        },
        { args: { items: [{ tier: "fast", prompt: "nested fanout" }] } },
      ),
    ).resolves.toBeUndefined();
  });

  it("depth-1 grader session: fanout is NOT blocked by the depth guard", async () => {
    // Grader sessions are depth-1; guard layer does not block fanout.
    const { ctx, sessionStore } = makeRealHarness();
    sessionStore.registerFromSessionCreated({ sessionID: "sid-grader", parentID: "sid-orch" });
    ctx.graderSessions.add("sid-grader");
    expect(sessionStore.depth("sid-grader")).toBe(1);

    await expect(
      handleToolExecuteBefore(
        ctx,
        {
          sessionID: "sid-grader",
          tool: "fanout",
          args: { items: [{ tier: "fast", prompt: "grader probing" }] },
        },
        { args: { items: [{ tier: "fast", prompt: "grader probing" }] } },
      ),
    ).resolves.toBeUndefined();
  });

  it("depth-1 delegate producer caller: fanout is NOT blocked by the depth guard", async () => {
    // Producer sessions (created via delegate) are depth-1; guard does not block.
    const { ctx, sessionStore } = makeRealHarness();
    sessionStore.registerFromSessionCreated({ sessionID: "sid-producer", parentID: "sid-orch" });
    sessionStore.registerProducerSession("sid-producer", "medium", ctx.initialConfig as any);
    expect(sessionStore.depth("sid-producer")).toBe(1);
    expect(sessionStore.isProducerSession("sid-producer")).toBe(true);

    await expect(
      handleToolExecuteBefore(
        ctx,
        {
          sessionID: "sid-producer",
          tool: "fanout",
          args: { items: [{ tier: "fast", prompt: "producer fanning" }] },
        },
        { args: { items: [{ tier: "fast", prompt: "producer fanning" }] } },
      ),
    ).resolves.toBeUndefined();
  });

  it("depth-0 orchestrator: fanout is NOT blocked by the depth guard", async () => {
    // Orchestrator (depth-0) has no nesting restriction; fanout passes through.
    const { ctx, sessionStore } = makeRealHarness();
    sessionStore.registerFromSessionCreated({ sessionID: "sid-orch", parentID: null as any });
    expect(sessionStore.depth("sid-orch")).toBe(0);
    expect(sessionStore.isDescendant("sid-orch")).toBe(false);

    await expect(
      handleToolExecuteBefore(
        ctx,
        {
          sessionID: "sid-orch",
          tool: "fanout",
          args: { items: [{ tier: "fast", prompt: "orchestrator fanout" }] },
        },
        { args: { items: [{ tier: "fast", prompt: "orchestrator fanout" }] } },
      ),
    ).resolves.toBeUndefined();
  });

  it("depth-2 grandchild: fanout is NOT blocked by the depth guard (defense in depth)", async () => {
    // Defense in depth: even depth-2 grandchild passes the guard layer for
    // fanout. The depth guard only blocks task/delegate (guards.ts:75).
    const { ctx, sessionStore } = makeRealHarness();
    sessionStore.registerFromSessionCreated({ sessionID: "sid-child", parentID: "sid-orch" });
    sessionStore.registerFromSessionCreated({ sessionID: "sid-grandchild", parentID: "sid-child" });
    expect(sessionStore.depth("sid-grandchild")).toBe(2);
    expect(sessionStore.isDescendant("sid-grandchild")).toBe(true);

    await expect(
      handleToolExecuteBefore(
        ctx,
        {
          sessionID: "sid-grandchild",
          tool: "fanout",
          args: { items: [{ tier: "fast", prompt: "deep fanout" }] },
        },
        { args: { items: [{ tier: "fast", prompt: "deep fanout" }] } },
      ),
    ).resolves.toBeUndefined();
  });
});
