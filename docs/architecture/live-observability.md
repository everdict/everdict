# Live observability — watch a run while it runs

Three layers close the "fire and wait" gap for running evals (parity with sandbox-cloud offerings:
full trace capture + remote progress viewing):

## ① Evidence fallback — `log` trace events (trace:none harnesses)

A black-box CLI harness (`trace: {kind: "none"}`) already emits its stdout tail as the final
assistant message; its **stderr** — where agents log progress — used to vanish on success (the
`error` event fires on exit≠0 only). `CommandHarness` now emits the stderr tail (16k cap) as a
`log` trace event (`{kind: "log", stream: "stdout"|"stderr", text}`) on every trace:none run,
success and failure alike. Harnesses with a platform trace are untouched (no double evidence).
Judges/graders/sinks that don't know the kind simply ignore it; the web trace timeline renders it.

## ② Live log tail — the job's stdout while the case runs

The harness's output now flows to the orchestrator job log AS IT RUNS: the in-job agent's
`LocalDriver({echo: true})` TEEs every exec's stdout/stderr through to the job's own stdio while
still buffering (the buffered result contract is unchanged — sentinel parsing, stdout fallback,
exit codes all identical; timeout kills the process group and reads exit 124).

On top of that job log:

- **`Backend.logs(caseId)`** (Nomad + K8s) — the case's newest job's current stdout, sentinel-
  stripped. Snapshot semantics, best-effort (queued/GC'd job → undefined), reuses the adopt lookup.
- **`GET /runs/:id/logs`** — snapshot `{status, found, text}`; the web run detail's LiveLogs widget
  polls it every 3s through the BFF and stops at a terminal status. MCP parity: `get_run_logs`.
- **`GET /runs/:id/logs/stream`** — SSE tail: appended chunks as JSON-encoded `data:` events every
  ~2s, heartbeat comments in between, `event: end {status}` when the run settles. For API users
  (`curl -N`) and future push UIs; the web widget deliberately polls (same pattern as the
  notification bell — no SSE plumbing through Next).

Scope: standalone runs (the run detail page). Batch children are addressable runs too, so the same
endpoints work on a child run id (drill in from the scorecard). The self-hosted runner path also
echoes (its terminal shows harness output), but `Backend.logs` covers nomad/k8s jobs only —
lease-queue lanes have no orchestrator job to read. `DockerDriver` (case.image jobs) now ALSO echoes
in-job (`DockerDriver({echo:true})` — same tee contract as LocalDriver), so case.image harnesses feed
the live log tail too.

Live-verified on Nomad: a 2s-tick harness showed `tick 1..6` in the mid-run snapshot, `tick 7..9`
six seconds later, and the SSE stream delivered the initial chunk, incremental `tick 10`, the final
line, then `event: end {"status":"succeeded"}`.

## ④ Sandbox web terminal — exec into the live case container

A new **`Backend.exec(caseId, command)`** seam runs a one-shot `sh -c command` inside the case's
live sandbox (Nomad: `nomad alloc exec -task agent <alloc>` shelling to the CLI with NOMAD_ADDR/
TOKEN in env — WS exec is CLI-only; K8s: `kubectl exec job/<name>`; both reuse the adopt lookup for
the newest RUNNING alloc/pod). undefined = no live container.

- **`POST /runs/:id/exec {command}`** → `{found, stdout, stderr, exitCode}`; MCP `exec_in_run`.
- Authz is tightened beyond `runs:read`: exec runs arbitrary (mutating) commands in the sandbox, so
  it's **the run's creator or a workspace admin only** (403 otherwise). The sandbox is already
  untrusted+isolated — this gates WHO may look in, not what runs there.
- Web: `LiveTerminal` on the run detail — a **persistent interactive shell over WebSocket** (⑥ below).
  `SandboxTerminal` (one-shot exec) remains for scripted/stateless use, but the run detail now mounts the
  interactive one.

Live-verified on Nomad: `whoami && ls /app` returned root + the image tree from inside a running
case; a failing command surfaced its stderr and exit 1.

## ⑤ Live screen — the desktop/browser frame while it runs

**`GET /runs/:id/screen`** → `{supported, found, dataUrl}`. For an **os-use** (desktop) case it
execs `DISPLAY=<display> scrot -o … && base64` via the ④ seam and returns a PNG data URL; the web
`LiveScreen` widget polls it every 2s into an `<img>`. `supported:false` for non-desktop env kinds
(no single-container screen — the widget renders nothing). Creator-or-admin, same as exec.

The env kind + display come from the persisted `caseSpec.env` (mig 0051), so the screen route needs
no extra state. Live-verified: the base64 frame transport round-tripped through `Backend.exec`
(PNGDATA and a 1×1 PNG in unit tests → `data:image/png;base64,…`), and the route correctly reported
`supported:true` for an os-use case (with `found:false` on the slim image, which has no scrot —
graceful). Full desktop capture is the same exec against an Xvfb image (remaining live check).

**browser-use (topology)** now works too: the per-case browser is a SIBLING container reached via CDP,
so the control plane rediscovers it by the CP-minted runId (`ServiceTopologyBackend` prefers
`job.runId`, so the browser alloc is keyed by the record-derivable id) and captures a live frame with
`captureCdpScreenshot` (find a page target → `Page.captureScreenshot` over the CDP WebSocket → base64
PNG). `RunService.screen` routes `env.kind === "browser"` to `Backend.captureScreen(runId)`; the same
web `LiveScreen` widget renders it (it keys off `supported`, not the env kind). The CDP-capture
primitive is live-verified against a real `chromedp/headless-shell` (a 15 KB PNG captured over CDP).
Nomad exposes the browser CDP as a host:port so rediscovery is clean; the **K8s** topology reaches CDP
through an ephemeral port-forward tied to the provision, so its `browserCdpBase` is a follow-up
(captureScreen returns undefined there — the widget just shows nothing). End-to-end browser-run screen
needs a live topology run (same remaining live check as os-use's Xvfb image).

## ⑥ Interactive terminal — a persistent shell over WebSocket

The one-shot exec (④) can't hold shell state (each call is a fresh `sh -c`). `Backend.execStream(caseId)`
opens a PERSISTENT interactive shell — Nomad `nomad alloc exec -i -task agent <alloc> /bin/sh` (K8s is a
follow-up: its kubeconfig is materialized per-dispatch, so a long-lived stream needs the temp file kept open)
— and returns a `{write, onData, onExit, close}` handle.

Transport: a browser can't set an Authorization header on a WebSocket, so an authenticated (creator-or-admin)
`POST /runs/:id/terminal-ticket` mints a short-lived (30 s) single-use ticket; the browser then opens
`WS /runs/:id/terminal?ticket=…` directly to the control plane (a `ws` `WebSocketServer` on Fastify's
`upgrade`). The upgrade handler consumes the ticket, opens the shell, and pipes bytes both ways. Two traps
handled: the terminal's early keystrokes are **buffered synchronously** and flushed once the shell is attached
(opening it does Nomad lookups — otherwise the first commands are lost), and the ready-state guard uses the
numeric `OPEN` (the `ws` instance constant is unreliable). The web `LiveTerminal` is line-oriented (command +
Enter, local echo — the shell has no TTY) so it needs no xterm.

Live-verified end to end on Nomad: over the WS, `cd /app; pwd` returned `/app` and
`SESSION=alive; echo persisted:$SESSION calc:$((6*7))` returned `persisted:alive calc:42` — cd AND the shell
variable survived across commands (a real persistent session), and a reused ticket was rejected (401).

## ③ Live trace deep-link — where the platform trace is accumulating

For harnesses that DO export a platform trace (otel/mlflow/langfuse/langsmith/phoenix), the
correlation used to be minted IN-JOB (`runCase`'s `newRunId()`), so nothing outside the job could
find the trace until the result landed. The control plane now mints it at dispatch and carries it
on the job (`CaseJob.runId`; `runCase` keeps its self-mint only as the no-CP fallback):

- standalone run → `evd-run-<record id>` · batch child → `evd-<scorecardId>-<caseId>[-t<n>]` —
  **derivable from the record alone**, zero lookups for observers.
- `GET /runs/:id` (and MCP `get_run`) adds a derived `liveTrace {kind, endpoint, runId}` while the
  run is queued/running and its harness exports a platform trace; the web run detail renders it as
  a deep-link callout ("트레이스가 mlflow 플랫폼에 실시간 적재 중" + the correlation id). Settled
  runs drop it — the collected trace/traceRef is the evidence then.
- Stability note: the id is stable across spillover/transient retries of the same record, so a
  re-attempt's spans land under the same address (more evidence, same search key). Collection
  behavior is unchanged (`collectTrace(runId)` uses the same value).

Live-verified against real MLflow: mid-run `GET /runs/:id` returned
`liveTrace {mlflow, http://…:5501, evd-run-<id>}`, the live log tail printed
`my-correlation=evd-run-<id>` from INSIDE the job (`$EVERDICT_RUN_ID` — zero coordination), and the
field disappeared once the run settled.

## ⑧ Runtime debugging — placement · topology health · failure evidence

The reads above answer "what is the AGENT doing"; this trio answers "what is the RUNTIME doing WITH MY
CASE" — the gap where a scorecard sat silently `queued`/`running` while the cluster couldn't place it, a
service was OOM-looping, or the evidence vanished with the deleted job.

### Case placement (`CaseInspectable`)

`Backend.inspectCase(caseId) → CasePlacement` (wire SSOT `@everdict/contracts/wire`): the case's newest
orchestrator job normalized to `phase queued | blocked | starting | running | dead` + the placed unit/node,
the scheduler's capacity verdict when blocked (Nomad blocked-evaluation exhausted dimensions / K8s
`FailedScheduling` message), an OOM verdict, restarts, and the orchestrator event feed (image pulls, kills).
Nomad + K8s implement it; the fan-out (`runtime-access.ts`) picks the first lane that answers. Surfaces:
`GET /runs/:id/placement` + MCP `get_run_placement` + the run detail's "Runtime placement" panel
(self-null when nothing to describe — e.g. self-hosted lanes). The Nomad dispatch wait loop also fires
`onWaiting("placement blocked — …")` the moment a blocked evaluation is first seen, so a batch child shows
the verdict as a step instead of silent queueing (managed twin of the self-hosted offline-runner reason).

### Topology health (`TopologyInspectable`)

For service harnesses the case job is only the driver — the thing that actually fails is the warm topology.
`ServiceTopologyBackend` implements `inspectTopology(harness, tenant) → TopologyStatus` (per-service state,
readiness, restart churn, OOM, last notable event — the STRUCTURED promotion of the old timeout-only
`diagnose()` string) and `topologyServiceLogs(harness, service, tenant)` (one service's log tail), backed by
new optional `TopologyRuntime` reads implemented by all three runtimes (Nomad alloc TaskStates · K8s pod
statuses via `Kubectl.podStatuses`/`logs` · Docker `ps`/`logs`). Surfaces: `GET /runs/:id/topology` +
`GET /runs/:id/topology/services/:service/logs` + MCP `get_run_topology`/`get_topology_service_logs` + the
run detail's "Service topology" panel (roster + per-row on-demand log fold; self-null for non-service runs).

### Failure evidence retention (`CaseFailure.placement`/`logTail`)

The orchestrator job (and its raw log) is deleted/GC'd right after settlement — post-mortem evidence must be
captured AT THROW TIME. Nomad (`waitForAlloc` failure paths, `parseResultOrExplain`) and K8s (`waitForJob`)
now attach `extra.placement {unit, node, events[]}` + `extra.logTail` (stderr-preferred, sentinel-stripped,
16 KB tail cap) to the thrown `UpstreamError`; `classifyFailure` lifts both onto the `CaseFailure`, and the
batch path's synthesized failed `CaseResult` carries the log tail as a `log` trace event — so the sealed
trajectory keeps the evidence after the cluster has long forgotten the job.
