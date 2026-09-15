# Plan 045 — Live Depth-2 Tree Probe Evidence

> **Probe status: PASS** — executed 2026-09-15 ~04:13-04:14 UTC against branch
> `advisor/045-fanout-tree` loaded via local plugin override
> (`file:///home/metalbolicx/Documents/opencode-smart-router`, fanout enabled).

## Probe target

Prove that fanout workers created via the SDK on this checkout have
`parentID === mediumCallerSid`, that no depth-3 session is ever created, and
that the synchronous aggregate returns within the batch bound without hanging
or causing TUI focus jumps.

## Setup steps performed

- [x] Reused the `*.pre-fanout-probe.bak` backups created by the Plan 044 probe
      (`opencode.json.pre-fanout-probe.bak`, `tiers.json.pre-fanout-probe.bak`)
      as the restore point.
- [x] Updated the plugin list entry in `~/.config/opencode/opencode.json` to
      `file:///home/metalbolicx/Documents/opencode-smart-router` (published
      `@latest` was still active after the first restart, which hid the tool).
- [x] Set `fanout.enabled: true` in the global `tiers.json`.
- [x] Validated both JSON files parse.
- [x] Operator restarted OpenCode; fresh session loaded the local checkout.

## Probe invocation

Root session dispatched the runtime Task tool with `subagent_type: medium`
(session title "Run tree fanout probe (@medium subagent)"). The complete child
prompt instructed the child to invoke the plugin-owned fanout tool directly
with two fast items returning fixed tokens, return the raw aggregate verbatim,
and never simulate fanout or use native Task.

## Captured evidence (from `~/.local/share/opencode/log/opencode.log`)

### Session IDs

- Root session: `ses_f5cd544e8ffeCzrU35KgkkAUdg`
- Medium caller session: `ses_f5cbac125ffe41cF6oLSCvzy0h` (created 04:13:39.419Z, `parentID=ses_f5cd544e8ffeCzrU35KgkkAUdg`)
- Worker A (fast): `ses_f5cbaab1bffe5nHRNlrMGBsgmF` (created 04:13:45.060Z)
- Worker B (fast): `ses_f5cbaab0fffeJdsDBi2DJm2gn5` (created 04:13:45.073Z)

### Parent chain (from server log `message=created` records)

- Worker A `parentID = ses_f5cbac125ffe41cF6oLSCvzy0h` — the medium caller.
- Worker B `parentID = ses_f5cbac125ffe41cF6oLSCvzy0h` — the medium caller.
- Both workers equal the caller; neither equals the root. caller-parenting
  proven at runtime: `root -> medium caller -> fast workers`.

### Depth containment

- No session in the log was created with `parentID` equal to either worker
  session. Depth 3 does not exist. No session creation occurred with a worker
  as parent.

### Aggregate response

Workers returned their completion text instead of the requested fixed tokens
(fast workers treated the token request as an idle recon prompt), but the
aggregate was produced by the real SDK executor:

```
## [1] tier=fast status=completed
DONE: @fast online — read-only recon ready (search, grep, read, git-info). Awaiting a real task; no work performed on this probe.

## [2] tier=fast status=completed
@fast online. Ready for read-only recon tasks in `opencode-smart-router` (search, grep, glob, file reads, quick git/type checks). What should I scout?
```

- Elapsed time from caller dispatch to aggregate: well under the 180s batch
  bound (workers created ~5.6s after the caller; the whole probe completed in
  seconds, comparable to the Plan 044 probe's ~1s worker run).
- Within `batchTimeoutMs` bound: YES.

### Telemetry / abort / cleanup observations

- No `fanout.circuit_open` or abort-failure symptoms; statuses are both
  `completed` (no timed_out / failed / cancelled / rejected).
- No unreconciled worker sessions remained; both sessions persisted by design
  (success path preserves them for review, no `session.delete`).
- No TUI focus jump, no hang, no unbounded response; the root session
  continued immediately after the aggregate returned.

## Verdict

**PASS — both caller-parented session creation AND no-depth-3 containment
hold.** The depth-2 tree is structurally real in the OpenCode server log.

## Restoration (operator to confirm after this session)

- [x] Restored `~/.config/opencode/opencode.json` plugin entry to
      `opencode-smart-router@latest` (from `opencode.json.pre-fanout-probe.bak`).
- [x] Restored `~/.config/opencode-smart-router/tiers.json` to
      `fanout.enabled: false` (from `tiers.json.pre-fanout-probe.bak`).
- [ ] Final restart to apply the restored default runtime config (operator).
