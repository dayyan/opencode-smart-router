# Runtime Probes — tier-fanout-tool (post-archive, STILL OWED)

> Written 2026-09-14 at the start of the probe setup. The two STOP-gated
> runtime assumptions from plan 044 were never executed live: every green
> test in the cycle is mocked. Until these probes pass, the feature is
> unit-proven but runtime-unproven.
>
> **If either probe fails, that is a plan STOP condition — report before
> building anything on top of the fanout feature.**

## State at probe time (already applied 2026-09-14)

1. `advisor/044-tier-fanout-tool` merged to master (`c578a18`); openspec
   archive committed (`4b86b63`). Working tree clean.
2. `~/.config/opencode/opencode.json` plugin array entry changed from
   `"opencode-smart-router@latest"` to
   `"file:///home/metalbolicx/Documents/opencode-smart-router"` — REQUIRED
   because the published npm package (1.10.0, and the stale 1.7.0 cache at
   `~/.cache/opencode/packages/`) contains NO fanout code. The live plugin
   must be the local repo.
3. `~/.config/opencode-smart-router/tiers.json` has `"fanout": {"enabled":
   true}`. The tool registers at LOAD time only
   (`src/plugin/runtime.ts:115`, gate on `ctx.initialConfig.fanout?.enabled
   === true`), so an **opencode restart is required** — which is why this
   session cannot run the probes itself.
4. Backups: `~/.config/opencode/opencode.json.pre-fanout-probe.bak` and
   `~/.config/opencode-smart-router/tiers.json.pre-fanout-probe.bak`.

## Probe 1 — plugin custom tool invocable from a depth-1 subagent session (STOP-gated)

The entire delivery mechanism is invalid if a depth-1 child cannot see and
invoke the plugin-owned `fanout` tool.

Procedure (from the ROOT session of a fresh opencode instance started after
the restart):

- Dispatch one `Task` with `subagent_type="medium"` (caller policy: only
  medium/focused/heavy may call fanout; medium workers must be `fast`) and a
  prompt equivalent to:
  "Call the `fanout` tool with items: [{tier: \"fast\", prompt: \"Reply
  with exactly PROBE_OK and nothing else.\"}, {tier: \"fast\", prompt:
  \"Reply with exactly PROBE_OK_2 and nothing else.\"}]. Then report the
  raw tool result verbatim."

PASS criteria (all must hold):
1. The child DISCOVERED the `fanout` tool (no unknown-tool error).
2. The tool executed and returned an aggregate containing both worker
   outputs (PROBE_OK, PROBE_OK_2) — workers ran without hanging.
3. The Task returned promptly (batch deadline is 180s default; a hang here
   is itself a FAIL).

## Probe 2 — root-parented `session.create` mid-flight does not hang (STOP-gated)

The core flattening safety assumption: while the medium child (Probe 1) is
mid-flight, the plugin creates worker sessions with `parentID = <ROOT sid>`
(root siblings), never `parentID = <child sid>`, and the create calls do
not hang.

Probe 1 exercises this operationally: the fanout call from the depth-1
child performs exactly these creates mid-flight.

Additional evidence to capture:
- From the fanout tool output / worker session IDs in Probe 1, confirm the
  workers are NOT nested under the child session ID. Optional deeper check:
  grep the opencode log for `fanout.session.created` (or equivalent)
  telemetry events and record the `parentID` values.
- The `fanout.unreconciled_worker` telemetry event must NOT fire during the
  probe (no lingering workers).

## Evidence (append raw outputs below this line)

- [x] Probe 1 executed: PASS
- [x] Probe 2 evidence captured: PASS

### Probe 1 result (2026-09-14)

The depth-1 medium child discovered and invoked the plugin-owned `fanout`
tool directly. Raw result:

```text
## [1] tier=fast status=completed
PROBE_OK

## [2] tier=fast status=completed
PROBE_OK_2
```

The call returned in approximately one second. There was no
`UNKNOWN_TOOL`, timeout, or error.

### Probe 2 result (2026-09-14)

OpenCode's own server log at
`~/.local/share/opencode/log/opencode.log` recorded the following session
creation relationships during the probe:

| Session | Observed parentID | Role |
|---|---|---|
| `ses_f5e51147effeqO44UyZeQNTT4c` | `ses_f5e5fe242ffeeUmmSpWKYBUnwU` | depth-1 medium caller |
| `ses_f5e50fe4fffeNPnRSBWAcJ0FbV` | `ses_f5e5fe242ffeeUmmSpWKYBUnwU` | fanout worker |
| `ses_f5e50fe44ffeVBgnXs73Ywlg2d` | `ses_f5e5fe242ffeeUmmSpWKYBUnwU` | fanout worker |
| `ses_f5e50ce4effeY05OHwHrPFv5Dn` | `ses_f5e5fe242ffeeUmmSpWKYBUnwU` | additional generic child observed in probe window |

The root session was `ses_f5e5fe242ffeeUmmSpWKYBUnwU`. The two fanout
workers were parented to that root, not to the medium caller, proving the
no-grandchildren invariant. Their session creation and prompts completed
without hanging.

The plugin's own `[model-router]` telemetry was not present in the OpenCode
log: `src/utils/observability.ts` writes to process stdout/stderr and has no
file sink. Therefore `fanout.unreconciled_worker` was not independently
observable; this is an evidence limitation, not a probe failure.

**STOP-gated verdict: PASS.** Both runtime assumptions passed. No further
feature implementation is blocked by these probes.

## After the probes (either outcome)

1. Record results above and commit this file.
2. Revert the plugin entry to `"opencode-smart-router@latest"` (restore
   from the backup or edit `~/.config/opencode/opencode.json`), restart
   again. The `fanout.enabled: true` flag in the global tiers.json is
   harmless to keep (it only activates when the loaded code supports it),
   but revert it too if you want the exact pre-probe state.
3. On PASS: the feature is runtime-proven; the remaining follow-ups are the
   cancellation-deviation decision and the configure() regression test
   (plans/044-handoff-post-archive.md).
4. On FAIL: STOP condition — file the failure with raw output; do not
   build on the feature until resolved.
5. Publishing decision (follow-up #7, version bump 1.10.0 → 1.10.1) is
   still open and separate from the probes.
