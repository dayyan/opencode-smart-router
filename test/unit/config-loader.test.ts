import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigLayer, RouterConfig, RouterState } from "../../src/router/config.types";
import { RouterConfigError } from "../../src/router/config-errors";
import {
  applyStateOverlay,
  deepMergeConfig,
  readConfigLayer,
} from "../../src/router/config-loader";

// ---------------------------------------------------------------------------
// Temp-dir setup (mirrors config-store.test.ts pattern)
// ---------------------------------------------------------------------------

let tmpHome: string;
let tmpCwd: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origXDG_CONFIG_HOME: string | undefined;
let origCwd: string;

beforeEach(async () => {
  origHOME = process.env.HOME;
  origUSERPROFILE = process.env.USERPROFILE;
  origXDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  origCwd = process.cwd();

  tmpHome = join(
    tmpdir(),
    `oc-loader-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.XDG_CONFIG_HOME;

  tmpCwd = join(tmpHome, "cwd");
  mkdirSync(tmpCwd, { recursive: true });
  process.chdir(tmpCwd);

  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

afterEach(async () => {
  if (origHOME === undefined) delete process.env.HOME;
  else process.env.HOME = origHOME;
  if (origUSERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUSERPROFILE;
  if (origXDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXDG_CONFIG_HOME;
  process.chdir(origCwd);
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

// ---------------------------------------------------------------------------
// readConfigLayer tests
// ---------------------------------------------------------------------------

describe("readConfigLayer", () => {
  // 1. Required layer missing (ENOENT) → throws RouterConfigError kind="unreadable"
  it("throws RouterConfigError (kind=unreadable) for a required layer that does not exist", async () => {
    const layer: ConfigLayer = {
      kind: "bundled",
      path: join(tmpHome, "missing.json"),
      required: true,
    };
    try {
      await readConfigLayer(layer);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterConfigError);
      expect((err as RouterConfigError).kind).toBe("unreadable");
    }
  });

  // 2. Optional layer missing (ENOENT) → returns undefined
  it("returns undefined for an optional layer that does not exist", async () => {
    const layer: ConfigLayer = {
      kind: "global",
      path: join(tmpHome, "absent.json"),
      required: false,
    };
    const result = await readConfigLayer(layer);
    expect(result).toBeUndefined();
  });

  // 3. Malformed JSON → throws RouterConfigError kind="malformed"
  it("throws RouterConfigError (kind=malformed) for malformed JSON", async () => {
    const filePath = join(tmpHome, "bad.json");
    writeFileSync(filePath, "{not valid json", "utf-8");
    const layer: ConfigLayer = { kind: "global", path: filePath, required: false };
    try {
      await readConfigLayer(layer);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterConfigError);
      expect((err as RouterConfigError).kind).toBe("malformed");
    }
  });

  // 4. Non-object root: array → throws RouterConfigError kind="malformed"
  it("throws RouterConfigError (kind=malformed) when JSON root is an array", async () => {
    const filePath = join(tmpHome, "array.json");
    writeFileSync(filePath, "[1,2,3]", "utf-8");
    const layer: ConfigLayer = { kind: "global", path: filePath, required: false };
    try {
      await readConfigLayer(layer);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterConfigError);
      expect((err as RouterConfigError).kind).toBe("malformed");
    }
  });

  // 5. Non-object root: null → throws RouterConfigError kind="malformed"
  it("throws RouterConfigError (kind=malformed) when JSON root is null", async () => {
    const filePath = join(tmpHome, "null.json");
    writeFileSync(filePath, "null", "utf-8");
    const layer: ConfigLayer = { kind: "global", path: filePath, required: false };
    try {
      await readConfigLayer(layer);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterConfigError);
      expect((err as RouterConfigError).kind).toBe("malformed");
    }
  });

  // 6. Valid object → returns parsed object
  it("returns the parsed object for a valid JSON file", async () => {
    const filePath = join(tmpHome, "valid.json");
    writeFileSync(filePath, JSON.stringify({ key: "value" }), "utf-8");
    const layer: ConfigLayer = { kind: "global", path: filePath, required: false };
    const result = await readConfigLayer(layer);
    expect(result).toEqual({ key: "value" });
  });
});

// ---------------------------------------------------------------------------
// deepMergeConfig tests
// ---------------------------------------------------------------------------

describe("deepMergeConfig", () => {
  // 1. Undefined base returns override
  it("returns override when base is undefined", () => {
    expect(deepMergeConfig(undefined, { a: 1 })).toEqual({ a: 1 });
  });

  // 2. Undefined override returns base
  it("returns base when override is undefined", () => {
    expect(deepMergeConfig({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  // 3. Both undefined
  it("returns undefined when both base and override are undefined", () => {
    expect(deepMergeConfig(undefined, undefined)).toBeUndefined();
  });

  // 4. Scalar override replaces base
  it("returns override when override is a scalar", () => {
    expect(deepMergeConfig(42, "hello")).toBe("hello");
  });

  // 5. Null is a scalar, not merged
  it("returns null override (null is not a plain object)", () => {
    expect(deepMergeConfig({ a: 1 }, null)).toBeNull();
  });

  // 6. Arrays replace, not concatenate
  it("returns override array (arrays are replaced, not merged)", () => {
    expect(deepMergeConfig([1, 2], [3])).toEqual([3]);
  });

  // 7. Recursive merge by key union
  it("deep-merges two plain objects by key union", () => {
    expect(deepMergeConfig({ a: { x: 1, y: 2 } }, { a: { y: 9, z: 3 } })).toEqual({
      a: { x: 1, y: 9, z: 3 },
    });
  });

  // 8. Nested scalar override in object
  it("replaces a nested object with a scalar when override has scalar at that key", () => {
    expect(deepMergeConfig({ a: { b: 1 } }, { a: 42 })).toEqual({ a: 42 });
  });
});

// ---------------------------------------------------------------------------
// applyStateOverlay tests
// ---------------------------------------------------------------------------

const makeCfg = (): RouterConfig => ({
  activePreset: "default",
  defaultTier: "medium",
  presets: { default: {} },
  rules: [],
  modes: { coding: { defaultTier: "fast", description: "" } },
});

describe("applyStateOverlay", () => {
  // 1. Valid activePreset is applied
  it("applies a valid activePreset", () => {
    const cfg = makeCfg();
    const state: RouterState = { activePreset: "default" };
    applyStateOverlay(cfg, state);
    expect(cfg.activePreset).toBe("default");
  });

  // 2. Invalid activePreset is ignored
  it("ignores an invalid activePreset", () => {
    const cfg = makeCfg();
    const original = cfg.activePreset;
    const state: RouterState = { activePreset: "nonexistent" };
    applyStateOverlay(cfg, state);
    expect(cfg.activePreset).toBe(original);
  });

  // 3. Valid activeMode is applied
  it("applies a valid activeMode", () => {
    const cfg = makeCfg();
    const state: RouterState = { activeMode: "coding" };
    applyStateOverlay(cfg, state);
    expect(cfg.activeMode).toBe("coding");
  });

  // 4. Invalid activeMode is ignored
  it("ignores an invalid activeMode", () => {
    const cfg = makeCfg();
    const state: RouterState = { activeMode: "unknown" };
    applyStateOverlay(cfg, state);
    expect(cfg.activeMode).toBeUndefined();
  });

  // 5. Valid enforcementMode is applied
  it("applies a valid enforcementMode", () => {
    const cfg = makeCfg();
    const state: RouterState = { enforcementMode: "enforced" };
    applyStateOverlay(cfg, state);
    expect(cfg.enforcement?.mode).toBe("enforced");
  });

  // 6. Invalid enforcementMode is ignored
  it("ignores an invalid enforcementMode", () => {
    const cfg = makeCfg();
    cfg.enforcement = { mode: "off" };
    const state: RouterState = { enforcementMode: "bogus" as any };
    applyStateOverlay(cfg, state);
    expect(cfg.enforcement?.mode).toBe("off");
  });

  // 7. Valid reasoningMode is applied
  it("applies a valid reasoningMode", () => {
    const cfg = makeCfg();
    const state: RouterState = { reasoningMode: "manual" };
    applyStateOverlay(cfg, state);
    expect(cfg.reasoningPolicy?.mode).toBe("manual");
  });

  // 8. Invalid reasoningMode is ignored
  it("ignores an invalid reasoningMode", () => {
    const cfg = makeCfg();
    cfg.reasoningPolicy = { mode: "static" };
    const state: RouterState = { reasoningMode: "bogus" as any };
    applyStateOverlay(cfg, state);
    expect(cfg.reasoningPolicy?.mode).toBe("static");
  });

  // 9. Empty state is a no-op
  it("leaves cfg unchanged when state is empty", () => {
    const cfg = makeCfg();
    const snapshot = JSON.stringify(cfg);
    const state: RouterState = {};
    applyStateOverlay(cfg, state);
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });

  // 10. enforcement created if absent
  it("creates enforcement object if it was absent when applying enforcementMode", () => {
    const cfg = makeCfg();
    // Capture a reference to the enforcement field before setting it to undefined
    const getEnforcement = () => cfg.enforcement;
    cfg.enforcement = undefined;
    const state: RouterState = { enforcementMode: "enforced" };
    applyStateOverlay(cfg, state);
    expect(cfg.enforcement).toBeDefined();
    expect(getEnforcement()?.mode).toBe("enforced");
  });
});
