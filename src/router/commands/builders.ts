// ---------------------------------------------------------------------------
// src/router/commands/builders.ts — Pure renderers for the router commands.
//
// Each builder is a PURE function: it reads the cfg + args (and the optional
// `resolved` state from the dispatcher), renders text, and returns it.
// The builders NEVER call `save*` from `./config` and NEVER mutate
// `ctx.reasoningStore.setOverride/clearOverride` — those side effects are
// the dispatcher's job (see `./dispatch.ts`).
//
// When `resolved` is present, the builder trusts it as the source of truth
// for the just-performed action (e.g. `resolved.enforceMode === "off"`) and
// renders the "set to X" message accordingly. When `resolved` is absent
// (legacy direct-test calls that remain untouched), the builder falls back
// to inferring the action from `args` — this is the parity path that keeps
// the existing 7+ direct builder tests green without modification.
//
// See sdd/plugin-decomposition/design § Phase 3 for the full rationale.
// ---------------------------------------------------------------------------

import type { PluginContext } from "../../plugin/context";
import { patchAtIndex, resolveControlPatch } from "../../reasoning/translate.js";
import type { ReasoningControl, ReasoningPolicyConfigV2, RouterConfig } from "../config";
import { resolvePresetName } from "../config";
import { resolveEnforcementMode } from "../enforcement";
import { getActiveTiers } from "../protocol";

// ---------------------------------------------------------------------------
// /router command output
// ---------------------------------------------------------------------------

export const buildRouterOutput = async (
  cfg: RouterConfig,
  args: string,
  _resolved?: { enforceMode?: "off" | "advisory" | "enforced" },
): Promise<string> => {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();
  if (sub === "enforce") {
    const mode = (tokens[1] ?? "").toLowerCase();
    if (mode === "off" || mode === "advisory" || mode === "enforced") {
      const desc =
        mode === "off"
          ? "Hard-block guard disabled (default routing behaviour)."
          : mode === "advisory"
            ? "Guard evaluates and surfaces banners but never hard-blocks."
            : "Guard hard-blocks subagent tool calls that violate budget / redundancy / self-script policy.";
      return [
        `Enforcement mode set to **${mode}** and persisted.`,
        "",
        desc,
        "",
        "Note: the `MODEL_ROUTER_ENFORCE` env var, when set to `0` or `1`, overrides this setting.",
      ].join("\n");
    }
    const current = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
    return [
      `Current enforcement mode: **${current}**`,
      "",
      "Usage: `/router enforce <off|advisory|enforced>`",
    ].join("\n");
  }
  const current = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
  return [
    `# Model Router`,
    `Enforcement: **${current}**`,
    "",
    "Commands:",
    "- `/router enforce <off|advisory|enforced>` — set hard-block enforcement (persisted)",
    "- `/tiers`, `/preset`, `/budget`, `/bypass`, `/annotate-plan`",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// /tiers command output
// ---------------------------------------------------------------------------

export const buildTiersOutput = (cfg: RouterConfig): string => {
  const tiers = getActiveTiers(cfg);
  const lines: string[] = [`# Model Delegation Tiers`, `Active preset: **${cfg.activePreset}**\n`];

  for (const [name, tier] of Object.entries(tiers)) {
    const thinkingStr = tier.thinking
      ? ` | thinking: ${tier.thinking.budgetTokens} tokens`
      : tier.reasoning
        ? ` | reasoning: effort=${tier.reasoning.effort}`
        : "";
    lines.push(`## @${name} -> \`${tier.model}\`${thinkingStr}`);
    lines.push(tier.description);
    if (tier.reasoningControl) lines.push(describeControl(tier.reasoningControl));
    lines.push(`Steps: ${tier.steps ?? "default"}`);
    lines.push(`Use when: ${tier.whenToUse.join(", ")}\n`);
  }

  lines.push("## Delegation Rules");
  for (const r of cfg.rules) lines.push(`- ${r}`);
  lines.push(`\nDefault tier: @${cfg.defaultTier}`);
  lines.push(`\nAvailable presets: ${Object.keys(cfg.presets).join(", ")}`);
  lines.push(`Switch with: \`/preset <name>\``);
  lines.push(`Edit \`tiers.json\` to customize.`);

  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// /budget command output
// ---------------------------------------------------------------------------

export const buildBudgetOutput = async (
  cfg: RouterConfig,
  args: string,
  _resolved?: { mode?: string },
): Promise<string> => {
  const modes = cfg.modes;
  if (!modes || Object.keys(modes).length === 0) {
    return 'No modes configured in tiers.json. Add a "modes" section to enable budget mode.';
  }

  const requested = args.trim().toLowerCase();
  const currentMode = cfg.activeMode || "normal";

  // No args: show current mode and available modes
  if (!requested) {
    const lines = ["# Routing Modes\n"];
    for (const [name, mode] of Object.entries(modes)) {
      const active = name === currentMode ? " <- active" : "";
      lines.push(
        `- **${name}**${active}: ${mode.description} (default tier: @${mode.defaultTier})`,
      );
    }
    lines.push(`\nSwitch with: \`/budget <mode>\``);
    return lines.join("\n");
  }

  // Switch mode
  if (modes[requested]) {
    const mode = modes[requested];
    return [
      `Routing mode switched to **${requested}**.`,
      "",
      mode.description,
      `Default tier: @${mode.defaultTier}`,
      ...(mode.overrideRules?.length
        ? ["", "Active rules:", ...mode.overrideRules.map((r) => `- ${r}`)]
        : []),
      "",
      "Mode change takes effect immediately on the next message.",
    ].join("\n");
  }

  return `Unknown mode: "${requested}". Available: ${Object.keys(modes).join(", ")}`;
};

// ---------------------------------------------------------------------------
// /preset command output
// ---------------------------------------------------------------------------

export const buildPresetOutput = async (
  cfg: RouterConfig,
  args: string,
  resolved?: { preset?: string },
): Promise<string> => {
  const requestedPreset = args.trim();

  // No args: show available presets
  if (!requestedPreset) {
    const lines = ["# Available Presets\n"];
    for (const [name, tiers] of Object.entries(cfg.presets)) {
      const active = name === cfg.activePreset ? " <- active" : "";
      const models = Object.entries(tiers)
        .map(([tier, t]) => `${tier}: ${t.model.split("/").pop()}`)
        .join(", ");
      lines.push(`- **${name}**${active}: ${models}`);
    }
    lines.push(`\nSwitch with: \`/preset <name>\``);
    return lines.join("\n");
  }

  // Switch preset
  const resolvedPreset = resolved?.preset ?? resolvePresetName(cfg, requestedPreset);
  if (resolvedPreset) {
    const tiers = cfg.presets[resolvedPreset];
    if (!tiers) {
      return `Unknown preset: "${requestedPreset}". Available: ${Object.keys(cfg.presets).join(", ")}`;
    }
    const models = Object.entries(tiers)
      .map(([tier, t]) => `  @${tier} -> ${t.model}`)
      .join("\n");
    return [
      `Preset switched to **${resolvedPreset}**.`,
      "",
      models,
      "",
      "Selection is now persisted in ~/.config/opencode/opencode-smart-router.state.json.",
      "Restart OpenCode for subagent model registration to take effect.",
      "System prompt delegation rules update immediately.",
    ].join("\n");
  }

  return `Unknown preset: "${requestedPreset}". Available: ${Object.keys(cfg.presets).join(", ")}`;
};

// ---------------------------------------------------------------------------
// /model-router-reasoning command output (Plan 041, Phase 2.5).
//
// Two responsibilities, parsed from the first token:
//   1. `mode <static|manual|adaptive>` — persist a runtime policy-mode switch.
//      The PERSIST call (saveReasoningMode) is in the dispatcher; the builder
//      only renders.
//   2. `<profile>` (one of the configured registry members, or `off`) — set /
//      clear the per-session override on `ctx.reasoningStore`. The override
//      mutation (setOverride/clearOverride) is in the dispatcher; the builder
//      only renders.
//
// Profile names are opaque. All command vocabulary comes from the policy
// registry; the builder does not know or enumerate bundled profile names.
// ---------------------------------------------------------------------------

/**
 * Describe a tier's configured reasoning control without interpreting its
 * profile IDs or native level names.
 */
export const describeControl = (control: ReasoningControl): string =>
  `Reasoning control: channel=${control.channel}, levels=[${control.levels.join(" < ")}], maxBumps=${control.maxBumps}`;

export const buildReasoningOutput = async (
  cfg: RouterConfig,
  args: string,
  _ctx: PluginContext,
  _sessionID: string,
  _resolved?: { policyMode?: "static" | "manual" | "adaptive" },
): Promise<string> => {
  const policy = cfg.reasoningPolicy as ReasoningPolicyConfigV2 | undefined;
  const surfaceLimits = policy?.surfaceLimits === true;
  const policyMode = policy?.mode ?? "static";
  const profiles = policy?.profiles ?? [];

  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();

  // Show help when no args — describe every active tier's capability and
  // the full subcommand surface (mode + level).
  if (tokens.length === 0) {
    const tiers = getActiveTiers(cfg);
    const lines: string[] = [
      `# Reasoning Overrides`,
      `Policy mode: **${policyMode}** (surfaceLimits: ${surfaceLimits ? "on" : "off"})`,
      "",
    ];
    for (const [name, tier] of Object.entries(tiers)) {
      lines.push(
        tier.reasoningControl
          ? `@${name}: ${describeControl(tier.reasoningControl)}`
          : `@${name}: no reasoning control (the tier is left as-is).`,
      );
    }
    lines.push(
      "",
      `Set per-session override: \`/model-router-reasoning ${profiles.join("|")}\`. Clear with \`/model-router-reasoning off\`.`,
      "Switch persisted policy mode: `/model-router-reasoning mode <static|manual|adaptive>`.",
      "Applies to the next `task` dispatch in this session only.",
    );
    return lines.join("\n");
  }

  // --- `mode` subcommand: persists a policy-mode overlay via state file. ---
  if (sub === "mode") {
    const modeArg = (tokens[1] ?? "").toLowerCase();
    if (!modeArg) {
      return [
        `Current reasoning policy mode: **${policyMode}**`,
        "",
        "Usage: `/model-router-reasoning mode <static|manual|adaptive>`",
        "`static` uses each tier's configured baseline.",
        `\`manual\` enables per-session overrides via ${profiles.join("|")}.`,
        "`adaptive` picks a profile from task signals (prompt + description + tier + trivial flag) via `reasoningPolicy.adaptive`.",
      ].join("\n");
    }
    if (modeArg === "static" || modeArg === "manual" || modeArg === "adaptive") {
      const desc =
        modeArg === "static"
          ? "Per-tier defaults are in effect — per-session overrides are ignored at task dispatch."
          : modeArg === "manual"
            ? `Per-session overrides are enabled — \`/model-router-reasoning ${profiles.join("|")}\` will take effect on the next task dispatch.`
            : "Adaptive selector picks the level from task signals (prompt + description + tier + trivial flag). Per-session overrides still win when set. Tune `reasoningPolicy.adaptive` (keywordRules, tierDefaults, defaultLevel) to taste.";
      return [
        `Reasoning policy mode set to **${modeArg}** and persisted.`,
        "",
        desc,
        "",
        "Takes effect on the next config refresh.",
      ].join("\n");
    }
    return `Unknown mode: "${modeArg}". Use one of: static, manual, adaptive (or run '/model-router-reasoning mode' for the current value).`;
  }

  // --- per-session override flow (registered profile|off) ---
  if (sub === "off") {
    return [
      "Reasoning override cleared.",
      "",
      "Next task dispatches in this session will use the tier's baseline reasoning.",
    ].join("\n");
  }

  const profile = tokens[0] ?? "";
  if (!profiles.includes(profile)) {
    return `Unknown profile: "${profile}". Use one of: ${profiles.join(", ")} (or "off" to clear).`;
  }

  // Per-tier acknowledgement: which tiers can actually satisfy the level,
  // which collapse, and which can't (none capability → silent no-op unless
  // surfaceLimits is enabled).
  const tiers = getActiveTiers(cfg);
  const lines: string[] = [
    `Reasoning override set to **${profile}** for this session.`,
    "",
    "Per-tier behaviour:",
  ];
  for (const [name, tier] of Object.entries(tiers)) {
    const control = tier.reasoningControl;
    if (!control) {
      if (surfaceLimits) lines.push(`- @${name}: unsupported (no reasoning control).`);
      continue;
    }
    const resolved = resolveControlPatch(control, profile);
    if (!resolved) continue;
    const patch = patchAtIndex(control, resolved.levelIndex);
    lines.push(`- @${name}: native = ${JSON.stringify(resolved.native)}.`);
    if (patch) lines.push(`  patch = ${JSON.stringify(patch)}.`);
  }
  lines.push("", "Takes effect on the next `task` dispatch in this session.");
  return lines.join("\n");
};
