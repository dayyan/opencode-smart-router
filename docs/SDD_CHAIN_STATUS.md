# SDD Chain Status — Plan 041 (user-owned-reasoning-profiles)

Source of truth: `openspec/changes/user-owned-reasoning-profiles/tasks.md` (master) and `plans/041-user-owned-reasoning-profiles.md`.

## Chain layout (stacked-to-main, auto-chain delivery, 400-line review budget)

| PR | Composed of | ~Lines | Status | Head branch |
|----|-------------|--------|--------|-------------|
| **#27** | WU-1 + WU-2 — v2 types, channel module, D-1 helper, D-4 capability, translate bridge | ~947 | **OPEN / MERGEABLE** | `advisor/041-user-owned-reasoning-profiles` |
| **#28** | WU-3..8 — full `resolveReasoningProfile` callers, `adaptive-selector.test.ts` rewrite, `ladder.ts` D-2/D-3, `delegate.ts` enterTier re-wire, `tool-guards.ts` call-site swap, integration test, commands registry-driven vocab | ~850 (size exception) | planned | `advisor/041-user-owned-reasoning-profiles` (stacked) |
| **#29** | WU-9 (R-3 atomic flip) — validators rewrite + `base.json` v2 + `presets.json` per-tier control + build-tiers comment + regenerated `tiers.json` + golden snapshots | ~550 (size exception, atomic) | planned | `advisor/041-user-owned-reasoning-profiles` (stacked) |
| **#30** | WU-10 + WU-11 — legacy identifier deletion + anti-hardcoding gate + docs | ~450 (size exception) | planned | `advisor/041-user-owned-reasoning-profiles` (stacked) |

## Commits landed in this chain (PR #27)

- `510522d` — feat(reasoning): WU-1 expand phase — v2 types, channel module, `resolveReasoningProfile` helper
- `cc367ef` — feat(reasoning): WU-2 translate.ts `resolveControlPatch` + `patchAtIndex`
- `f7ad874` — style(reasoning): WU-2 biome conformance — import organization

## Runtime notes

- Worktree: `/tmp/opencode/smart-router-041` (on `advisor/041-user-owned-reasoning-profiles`)
- All WU work continues on the existing branch; no new branches created.
- Strict TDD applies; all changes ship RED → GREEN → REFACTOR.
