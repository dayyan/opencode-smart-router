# Session Handoff — Plan 044 (tier-fanout-tool) post-archive

> Written 2026-09-14 at the end of the SDD cycle that implemented
> `plans/044-tier-fanout-tool.md`. The next session's job is merge
> housekeeping + follow-up decisions. Do NOT re-implement anything —
> the feature is complete and archived.

## Next Session Focus

1. **Clean the main repo working tree (DO THIS FIRST — blocks a clean merge).**
2. Merge `advisor/044-tier-fanout-tool` into `master` (user decides when).
3. **Enable the feature + run the never-executed runtime smoke probes** (see "Runtime probes still owed" below) — the tool ships default-off and two STOP-gated runtime assumptions were never proven against a live opencode runtime.
4. Decide + execute the two open follow-ups (cancellation deviation; configure() test).

## Context & Summary

The full SDD cycle for the `fanout` tool (child-initiated lower-tier parallel
delegation) is **complete and archived**: final verify verdict **PASS WITH
WARNINGS** (0 blockers, 9/9 requirements, 10/10 scenarios, 0 NEW
baseline-relative regressions). Branch `advisor/044-tier-fanout-tool` @
`c578a18`, 12 commits, worktree `/tmp/opencode/smart-router-044`.

### IMMEDIATE: main repo working tree is contaminated (verified via `git status`)

The PR 1 worker wrote to BOTH checkouts (known failure mode, engram #4633).
The main repo at `/home/metalbolicx/Documents/opencode-smart-router` has
**stale uncommitted PR 1-era duplicates** that will conflict with the merge:

| Path (main repo, unstaged) | Action | Why |
|---|---|---|
| `src/router/config-validate.ts` | `git restore` | Stale PR 1 copy; advisor branch has newer (Fix PR 1 tightened key domain) |
| `src/router/config.types.ts` | `git restore` | Duplicate of committed work |
| `src/router/sessions.ts` | `git restore` | Duplicate |
| `test/unit/config-validate-sections.test.ts` | `git restore` | Stale duplicate |
| `test/unit/sessions.test.ts` | `git restore` | Duplicate |
| `pnpm-lock.yaml` | `git restore` | Install-run noise; no dependency added |
| `test/unit/fanout-config-defaults.test.ts` (untracked) | `rm` or `git clean -f` | Duplicate of file on advisor branch |
| `package.json` (test:res script) | restore OR keep | Also on advisor branch; either way converges after merge |
| `plans/README.md` (044 DONE row) | restore OR keep | Same — converges after merge |

**KEEP (do not delete)** — canonical artifacts that exist ONLY in the main repo (untracked):
- `openspec/changes/archive/2026-09-14-tier-fanout-tool/` — the archived change
- `openspec/specs/fanout-config/` + `openspec/specs/tier-fanout/` — promoted domain specs
- `plans/044-handoff-post-archive.md` — this handoff file (it is also untracked; commit it)

Commit these openspec artifacts (with the merge or as a separate `docs(openspec)` commit).

### Merge procedure (after cleanup)

```
git restore src/router/config-validate.ts src/router/config.types.ts src/router/sessions.ts \
  test/unit/config-validate-sections.test.ts test/unit/sessions.test.ts pnpm-lock.yaml package.json plans/README.md
rm test/unit/fanout-config-defaults.test.ts
git merge advisor/044-tier-fanout-tool   # then verify: pnpm run typecheck && pnpm test (expect 1 pre-existing packaging failure)
```

Baseline reminder (cycle-6 note): `packaging.test.ts` flatMap failure is
PRE-EXISTING at `047215f` — "no NEW failures vs baseline" is the gate, not exit 0.

After the merge (hygiene): `git worktree remove /tmp/opencode/smart-router-044`
(or `git worktree prune` if /tmp was wiped — the branch lives in the main repo's
refs, verified present, so nothing is lost) and `git branch -d advisor/044-tier-fanout-tool`.

Runtime attempt ledger: the tier-fanout-tool objective is settled complete;
follow-up PRs just `sdd-attempt acquire` with a NEW work-unit label — no reset needed.

### Runtime probes still owed (STOP-gated assumptions never proven live)

Every green test in the cycle is mocked. The two runtime probes the plan gated
on (tasks rows 3a/3b) were NEVER executed, and the "optional post-merge probe"
from row 5 never ran either. The first verify report explicitly said to capture
them at archive time; the archive did not. Until these pass, treat the feature
as unit-proven but runtime-unproven:

1. **Plugin custom tool invocable from a depth-1 subagent session** — if false,
   the entire delivery mechanism is invalid (plan STOP condition).
2. **`session.create` with `parentID = <root sid>` while a tier child is
   mid-flight does not hang** — the core flattening safety assumption (plan STOP
   condition).

Probe procedure (post-merge): set `fanout.enabled: true` in the router config
(the tool registers at load time — `runtime.ts` gate on
`ctx.initialConfig.fanout?.enabled === true`, so an **opencode restart is
required** after enabling), dispatch a medium/focused/heavy child, confirm the
`fanout` tool is discovered, workers run without hanging, and no session is ever
created with `parentID = <child sid>`. Archive the probe output as evidence
(suggested: `openspec/changes/archive/2026-09-14-tier-fanout-tool/runtime-probe.md`).
If either probe fails, that is a plan STOP condition — report before building on top.

### Missing work (triaged follow-ups — the archive warnings)

| # | Warning | Recommendation |
|---|---|---|
| 1 | **Mid-race cancellation returns the cancelled aggregate, not `""`** — code/spec/test disagree (test documents the deviation at `plugin-fanout.test.ts:~838`). Spec says `""`. | **Decision needed.** Either amend the spec (accept aggregate; it carries typed `cancelled` outcomes) or change ~5 lines in `src/plugin/fanout.ts` + test. Do not leave the three-way disagreement. |
| 2 | **No test exercises `configure()` with non-default caps end-to-end** (R-3 could silently regress — a refactor detaching `configure()` would keep the suite green). | Small follow-up PR: 1-2 tests driving the real store with `maxConcurrentGlobal: 1` + 2 items. |
| 3 | **`fanout.unreconciled_worker` telemetry never exercised by a runtime probe** (Lingering-worker scenario not operationally visible). | Optional; matters only if production visibility into stuck workers is required. |
| 4 | W-3/W-4 heuristics (batch-expiry race; half-open probe atomicity) | Accepted limitation — no action; documented in design. |
| 5 | Path C process isolation | Deferred by design; only revisit if production telemetry shows bounded-response isn't enough (ROI: native 47 / in-process 82 / isolated 76). |
| 6 | loader-export test flake (observed once under load, passes isolated) | Monitor only. |
| 7 | No version bump / publish step anywhere in plan 044 (plugin is at 1.10.0) | Decide before publishing; feature is default-off so not urgent — `prepublishOnly` runs build + test:gate. |

## External Artifacts (read these — do not re-derive)

- [Archive report](../openspec/changes/archive/2026-09-14-tier-fanout-tool/archive-report.md) — outcomes, design decisions, follow-ups
- [Final verify report](../openspec/changes/archive/2026-09-14-tier-fanout-tool/verify-report.md) — PASS WITH WARNINGS evidence, per-gate results
- [Plan 044](plans/044-tier-fanout-tool.md) — canonical engineering intent, STOP conditions
- [Promoted specs](../openspec/specs/) — `fanout-config` (4 req) + `tier-fanout` (5 req)
- [tasks.md](../openspec/changes/archive/2026-09-14-tier-fanout-tool/tasks.md) — 6-PR breakdown, all checked
- Engram (search `architecture/fanout-*`, `maintenance/sdd-plugin-baseline`): #4963 (confirmed decisions), #4969 (half_open fix), #4975 (cycle outcome), #4633 (worktree-contamination lesson)

## Key findings worth remembering (not recorded elsewhere in repo docs)

- **gentle-ai upgrades silently overwrite `~/.config/opencode/plugins/*`.** Run
  `~/.config/opencode/plugin-tests/verify-sdd-plugin.sh` after every `brew upgrade gentle-ai`;
  exit 10 → restore from the local git baseline (tag `sdd-plugin-fix-v1`). This caused the
  session's initial `sdd_task_result_malformed` failure. Runbook:
  `~/.config/opencode/plans/001-maintain-sdd-plugin-fix.md`.
- **Runtime ledger counts changed lines differently from git diff** (545 vs 422 for the same
  commits). Size acquire budgets at ~1.3-2x the git-diff estimate, or expect `maintainer_decision`
  resets. Biome auto-format can inflate a test fixture diff by ~140 lines — write multi-line-safe
  fixtures from the start.
- **sdd-apply workers optimize for `pnpm test` green and skip `pnpm run typecheck`/`lint`.**
  Every apply dispatch prompt must explicitly require BOTH gates before settling. This single
  omission caused verify round 1's R-1/R-2 CRITICALs and round 2's N-1.
- **The verifier found real bugs tests missed** (breaker `!== 'closed'` rejecting half_open
  probes; `failed` kind conflating prompt errors with abort failures). Containment tests that
  drive the executor end-to-end are what caught them — keep that test style.

## Suggested Skills

- `handoff` — this document's skill (already applied)
- `improve` — for `plan`-variant follow-ups (configure() test, cancellation decision)
- `customize-opencode` — if touching plugin/config files under `~/.config/opencode`
- `work-unit-commits` — for the follow-up PR commit structure
- `sdd-*` agents — only if the user starts a new formal SDD change (the follow-ups above are
  small enough for direct/delegated work; do not spin up a full cycle for them)
