/**
 * test/unit/no-hardcoded-reasoning-vocabulary.test.ts
 *
 * Phase 4, Task 4.2 — R-4 anti-hardcoding gate.
 *
 * Verifies that after the user-owned-reasoning-profiles refactor:
 *   (a) No legacy reasoning vocabulary identifiers remain in src/reasoning/ or src/router/
 *   (b) No "minimal" / "elevated" profile-name literals remain in those same dirs
 *
 * These strings/identifiers are the old contract (Plan 041 v1). The v2 contract
 * uses profile IDs "light", "standard", "deep" registered in reasoningPolicy.profiles.
 *
 * This test MUST pass on the first run (R-4 mandate). If it fails the refactor
 * is incomplete and must be corrected before the PR is merged.
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Use process.cwd() (the vitest working directory) rather than import.meta.url,
// which resolves to the canonical repo when running inside a worktree.
const REASONING_SRC = join(process.cwd(), "src/reasoning");
const ROUTER_SRC = join(process.cwd(), "src/router");

/**
 * Identifiers that existed in the pre-Plan-041 v1 reasoning module and must NOT
 * appear anywhere in src/reasoning/ or src/router/ after the refactor.
 *
 * Covers Task 4.1 legacy-deletion list plus the EscalatePolicy.reasoningEscalation
 * field that was removed alongside buildEscalatePolicy's reasoning-carrying overload.
 */
const BANNED_IDENTIFIERS = [
  // Named type exports from the old reasoning module
  "ReasoningLevel",
  "ReasoningCapability",
  // Discrete-rank ladder constants
  "DISCRETE_RANK",
  // Variant flavour constants (replaced by channel-based profile map)
  "POSITIONAL_VARIANTS",
  "NAMED_VARIANTS",
  // Free functions that were removed in favour of resolveReasoningProfile
  "inferCapability",
  "translateLevel",
  "levelIndexForVariant",
  "capabilityLadderLength",
  "detectCollapse",
  // Old top-level override resolver (superseded by resolveReasoningProfile)
  "resolveReasoningOverride",
  // Old level-name constant array (superseded by profile registry)
  "REASONING_LEVELS",
  // Old escalation carry — EscalatePolicy.reasoningEscalation field + builder overload
  "ReasoningEscalationConfig",
  "reasoningEscalation",
  "buildEscalatePolicy",
] as const;

/**
 * Legacy profile-name literals from the pre-Plan-041 v1 contract.
 * The v2 contract registers these as "light" → "minimal", "deep" → "elevated"
 * via the profile remap table in the tasks artifact. These string values must
 * NOT appear as raw literals in source code.
 */
const BANNED_LITERALS = ["minimal", "elevated"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FileFilter = (filename: string) => boolean;
const TS_OR_MJS: FileFilter = (f) => f.endsWith(".ts") || f.endsWith(".mjs");

/**
 * Recursively collect all file paths under `dir` matching `filter`.
 * Symlinks are followed.
 */
function collectFiles(dir: string, filter: FileFilter, collected: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        collectFiles(full, filter, collected);
      } else if (filter(entry)) {
        collected.push(full);
      }
    } catch {
      // Skip files we can't read
    }
  }
  return collected;
}

/** Search `content` for each identifier in `banned` and report hits. */
function findBannedIdentifiers(content: string, banned: readonly string[]): Map<string, number[]> {
  const hits = new Map<string, number[]>();
  const lines = content.split("\n");
  for (const id of banned) {
    const re = new RegExp(`\\b${id}\\b`, "g");
    const lineNos: number[] = [];
    lines.forEach((line, idx) => {
      if (re.test(line)) lineNos.push(idx + 1);
      re.lastIndex = 0;
    });
    if (lineNos.length > 0) hits.set(id, lineNos);
  }
  return hits;
}

/** Search `content` for each banned string literal and report hits. */
function findBannedLiterals(content: string, banned: readonly string[]): Map<string, number[]> {
  const hits = new Map<string, number[]>();
  const lines = content.split("\n");
  for (const lit of banned) {
    const re = new RegExp(`(["'])${lit}\\1`, "g");
    const lineNos: number[] = [];
    lines.forEach((line, idx) => {
      if (re.test(line)) lineNos.push(idx + 1);
      re.lastIndex = 0;
    });
    if (lineNos.length > 0) hits.set(lit, lineNos);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("no-hardcoded-reasoning-vocabulary", () => {
  const allFiles = [
    ...collectFiles(REASONING_SRC, TS_OR_MJS),
    ...collectFiles(ROUTER_SRC, TS_OR_MJS),
  ];

  it("has at least one source file to check (sanity)", () => {
    expect(allFiles.length).toBeGreaterThan(0);
  });

  describe.each(BANNED_IDENTIFIERS)("banned identifier: %s", (id) => {
    it(`'${id}' must not appear in src/reasoning/ or src/router/`, () => {
      const failures: Array<{ file: string; lines: number[] }> = [];
      for (const file of allFiles) {
        const content = readFileSync(file, "utf-8");
        const hits = findBannedIdentifiers(content, [id]);
        if (hits.size > 0) {
          failures.push({ file, lines: [...hits.values()][0] });
        }
      }
      expect(
        failures,
        `${id} found in:\n${failures.map((f) => `  ${f.file}:${f.lines.join(",")}`).join("\n")}`,
      ).toHaveLength(0);
    });
  });

  describe.each(BANNED_LITERALS)("banned literal: %s", (lit) => {
    it(`"${lit}" string literal must not appear in src/reasoning/ or src/router/`, () => {
      const failures: Array<{ file: string; lines: number[] }> = [];
      for (const file of allFiles) {
        const content = readFileSync(file, "utf-8");
        const hits = findBannedLiterals(content, [lit]);
        if (hits.size > 0) {
          failures.push({ file, lines: [...hits.values()][0] });
        }
      }
      expect(
        failures,
        `"${lit}" found in:\n${failures.map((f) => `  ${f.file}:${f.lines.join(",")}`).join("\n")}`,
      ).toHaveLength(0);
    });
  });

  it("reasoningPolicy mode constants must not include legacy level names as raw values", () => {
    // As a secondary guard, catch bare (unquoted) use of the old level names
    // in contexts that strongly suggest they are being used as profile identifiers
    // rather than incidental vocabulary (e.g. a switch-case like `case minimal:`).
    //
    // We use a negative lookahead / lookbehind to exclude known false positives:
    //   - "a minimal DoD"  (protocol.ts — minimal in the sense of "smallest")
    //   - "minimal Node"    (error-classify.ts — minimal Node.js build)
    //
    // Any bare use of minimal/elevated that IS a profile identifier will still
    // be caught here; the primary string-literal test above is the authoritative
    // guard for the R-4 mandate.
    const findings: Array<{ file: string; line: string; lineNo: number }> = [];
    for (const file of allFiles) {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        // Strip single-line comments and JSDoc block comments.
        // Multi-line JSDoc comments on a single line take the form /** ... */ and
        // can be stripped with a simple replace.
        const code = line
          .replace(/\/\/.*$/, "") // single-line //
          .replace(/\/\*\*.*?\*\//g, "") // JSDoc /** ... */ on one line
          .replace(/\/\*.*?\*\//g, ""); // /* ... */ on one line

        // Known false positives — historical command syntax in comments describing
        // the old v1 contract. These are not code using old vocabulary.
        if (/model-router-reasoning (elevated|minimal)/.test(code)) return;
        // Match bare minimal/elevated NOT preceded by "a " or followed by " DoD" or "Node"
        const bareMinimalRe = /(?<![a-zA-Z])minimal\b(?!\s+DoD)(?!\s+Node\b)/;
        const bareElevatedRe = /(?<![a-zA-Z])elevated\b/;
        if (bareMinimalRe.test(code) || bareElevatedRe.test(code)) {
          findings.push({ file, line: line.trim(), lineNo: idx + 1 });
        }
      });
    }
    expect(
      findings,
      `Legacy vocabulary found in code:\n${findings.map((f) => `  ${f.file}:${f.lineNo}: ${f.line}`).join("\n")}`,
    ).toHaveLength(0);
  });
});
