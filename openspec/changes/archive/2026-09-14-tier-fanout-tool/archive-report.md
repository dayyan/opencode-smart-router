# Archive Report: tier-fanout-tool

**Change**: tier-fanout-tool  
**Archived**: 2026-09-14  
**Status**: PASS WITH WARNINGS  
**Verification commit**: `c578a18`  
**Artifact store**: openspec  

---

## Intent

Child-initiated lower-tier parallel delegation via a plugin-owned `fanout` tool. Bounded parallel workers on the caller's root session without creating physical grandchildren; native task/delegate nesting guards remain unchanged.

---

## Scope Summary

- **9 requirements** across 2 domains (`fanout-config`, `tier-fanout`)
- **10 scenarios** — all passing at runtime
- **12 commits** total: 7 implementation PRs + 4 fix PRs + 1 plans/README.md status row
- **~3,300 lines** cumulative across 16 files (config types, plugin, tests, docs, prompt updates)
- **Delivery**: 6-PR `stacked-to-main` chain (`advisor/044-tier-fanout-tool`)

---

## Outcomes

| Metric | Value |
|--------|-------|
| Verification verdict | PASS WITH WARNINGS |
| Blockers | 0 |
| Requirements | 9/9 passing |
| Scenarios | 10/10 passing |
| Baseline-relative regressions | 0 NEW |

**Pre-existing failure unchanged**: `packaging.test.ts flatMap` — present at baseline `047215f`, unrelated to fanout implementation.

---

## Follow-Up Warnings

1. **`configure()` with non-default caps** — no explicit test exercises `configure()` updating fanout caps at runtime; add if dynamic reconfiguration is a supported use case.
2. **`fanout.unreconciled_worker` telemetry gap** — emitted on `abort_failed` + lingering worker, but no runtime test exercises the exact `Lingering worker` scenario end-to-end; recommend adding if production visibility into unreconciled state is required.
3. **Path B process-isolation deferred** — in-process sibling worker backend shipped; process-isolation escalation plan not yet implemented.
4. **`failed` kind split** — `prompt error` vs `abort_failed cleanup timeout` are distinguishable outcomes; ensure consumers that match on `kind === "failed"` handle both subtypes correctly.

---

## Key Design Decisions

| Decision | Rationale | Source |
|----------|-----------|--------|
| In-process sibling worker backend (Path B) | Lower complexity, same isolation boundary for production use; process-isolation deferred as future escalation | ROI analysis + engram #4963 |
| 6-PR chained delivery with `stacked-to-main` | ~3,300 lines exceeded 400-line review budget; PR 3 split into 3a/3b to fit 450-line budget | Review Workload Guard |
| Half_open breaker bug fixed at `fanout.ts:196` (`===` → `!==`) | `=== open` kept probe blocked; `!== closed` correctly gates probe entry | engram #4969 |
| `failed` kind split into `prompt error` vs `abort_failed` | Different root causes require distinct handling by callers | Design review |
| Strict `maxConcurrentPerTier` key validation = active preset ∩ {fast, light, medium} | Unknown keys rejected at config load to prevent silent misconfiguration | engram #4963 (confirmed decision) |
| Empty `items: []` returns typed `rejected` with zero SDK calls | Defensive; avoids empty batch round-trip overhead and potential SDK edge cases | engram #4963 (confirmed decision) |
| `session.delete` never called; abort-only cleanup bounded at 10s | Safety invariant; sessions persist on success, abort on failure/cancellation | Design + STOP conditions |

---

## Spec Compliance

| Domain | Requirements | Status |
|--------|-------------|--------|
| `fanout-config` | 4/4 | All passing |
| `tier-fanout` | 5/5 | All passing |

All 10 scenarios have passing covering tests at runtime per `verify-report.md`.

---

## Binding STOP Conditions

All held at archive time:

- ✅ No `fanout` entry in `task`/`delegate` guards in `src/plugin/hooks/tool-guards.ts`
- ✅ No `session.delete` in `src/plugin/fanout.ts`
- ✅ Workers always `parentID = rootSid` (caller's parent); no-grandchild invariant asserted per batch
- ✅ `items: []` → typed `rejected`, zero SDK calls
- ✅ Empty batch → typed `rejected` with zero SDK calls
- ✅ Unknown `maxConcurrentPerTier` keys → typed config-load error

---

## Spec Sync

Both domains are **new** (no pre-existing main specs). Delta specs were mechanically copied as full specs:

| Domain | Action | Details |
|--------|--------|---------|
| `fanout-config` | Created | 4 requirements, 4 scenarios |
| `tier-fanout` | Created | 5 requirements, 6 scenarios |

---

## Pre-SDD Memory Trail

| Observation | Topic |
|------------|-------|
| #4963 | Pre-proposal handoff: typed error on unknown config keys; typed rejected for empty batches |
| #4969 | Half_open breaker bug fix at `fanout.ts:196` (`===` → `!==`) |
| #4975 | Final cycle outcome |

---

## SDD Cycle Complete

The change has been fully planned (plan 044), proposed, specified, designed, implemented, verified, and archived.
Ready for the next change.
