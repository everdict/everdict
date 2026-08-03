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
- Web: `LiveTerminal` on the run detail — a **persistent interactive shell over WebSocket** (⑥ below). A shell is a
  real process in the sandbox, so the widget attaches only when the reader presses "open a shell"; mounting it
  eagerly would open one per viewer of every running run. `SandboxTerminal` (one-shot exec) remains for
  scripted/stateless use.

Live-verified on Nomad: `whoami && ls /app` returned root + the image tree from inside a running
case; a failing command surfaced its stderr and exit 1.

## ⑤ Live screen — the desktop/browser frame while it runs

**`GET /runs/:id/screen`** → `{supported, found, dataUrl}` (+ MCP `get_run_screen`). For an **os-use** (desktop)
case it execs `DISPLAY=<display> scrot -o … && base64` via the ④ seam and returns a PNG data URL; the web
`LiveScreen` widget polls it every 2s into an `<img>`. Creator-or-admin, same as exec.

**`supported` reports what could actually be captured, not what the case's declared env kind implies.** The env
kind is a poor proxy in both directions: a `browser` case on a lane with no per-case rediscovery (K8s topology)
would answer `supported:true` forever and park the viewer in front of a frame that could never arrive, while a
service harness drives a real browser with its case env set to `prompt` (the browser belongs to the topology, not
to the case) and was never even offered one. So the capture attempt IS the support test — the per-case browser is
tried for any run with a runtime lane, and `supported:false` means "nothing here we can reach", at which point the
widget renders nothing at all. The cost of the old answer was a permanently empty box that read as a hang.

The env kind + display come from the persisted `caseSpec.env` (mig 0051), so the screen route needs
no extra state. Live-verified: the base64 frame transport round-tripped through `Backend.exec`
(PNGDATA and a 1×1 PNG in unit tests → `data:image/png;base64,…`), and the route correctly reported
`supported:true` for an os-use case (with `found:false` on the slim image, which has no scrot —
graceful). Full desktop capture is the same exec against an Xvfb image (remaining live check).

**A session-acquired browser** (`target.acquire.mode: "service"` — the harness's own playwright-server/Browserbase-
style session API, no Everdict container) is observable when the session API says where to look: `acquire.cdpBase`
is a dot-path into the open response yielding a **control-plane-reachable** CDP base, distinct from the agent-facing
coordinate in `coordinates`, which is usually an internal alias the observer cannot reach. It fills
`TargetEnvHandle.cdpBase`, which is what both the environment recorder (replay ②) and the live screen key off — so
one declaration lights up network/console/nav + screencast recording AND the live view. `ServiceTopologyBackend`
publishes that address per runId for the duration of the drive, because `captureScreen` runs on a different call
stack than `dispatch` and can otherwise only ask the runtime to rediscover a browser IT provisioned (which also
resolves the zone-correct address — the rediscovery call could not see the trust zone). Declared-but-unresolvable
degrades visibly: the run's trajectory carries an `infra` event saying the session returned no reachable CDP.

**Which tab is watched** is a decision, not an accident, once an extension is in the picture: such a browser
always reports several page targets (the extension's side panel, a blank tab, the tab the agent works in), so
"the first page target" put the live view, a graded screenshot, and the whole environment recording on whichever
one Chrome happened to list first. `pickPageTarget` (`front-door/capture-cdp.ts`, shared by the captures, the
recorder and the interactive session) respects the browser's most-recently-active ordering — the signal for which
tab is the work surface, which a session server makes deterministic by bringing it to front — and only filters
what can never be it (a blank tab). Judging by URL is deliberately avoided: an extension-driven work tab starts
out on a `chrome-extension://` page itself, so a rule that skips extension URLs picks the blank tab at exactly
the moment recording starts (live-verified — it produced an empty replay while the live screen looked fine).

**Saved-profile injection** follows the same address as the live reads: the acquired target's own `cdpBase` first,
the runtime's rediscovery second. Asking the runtime alone meant a session-acquired browser silently ran
logged-out, which scores as a capability failure rather than a configuration one.

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
`FailedScheduling` message), an OOM verdict, restarts, the unit's live resource ask (`cpu`/`memoryMb` — Nomad
`resources=true` AllocatedResources / K8s pod requests) + `ageSeconds`, and the orchestrator event feed (image
pulls, kills). The run detail's meta strip links the runtime lane to the runtime detail page (the Lens-style
cluster console — `inspect_runtime`), so case → node → cluster is one click each.
Nomad + K8s implement it; the fan-out (`runtime-access.ts`) picks the first lane that answers. Surfaces:
`GET /runs/:id/placement` + MCP `get_run_placement` + the run detail's "Runtime placement" panel
(self-null when nothing to describe — e.g. self-hosted lanes). The Nomad dispatch wait loop also fires
`onWaiting("placement blocked — …")` the moment a blocked evaluation is first seen, so a batch child shows
the verdict as a step instead of silent queueing (managed twin of the self-hosted offline-runner reason).

### Topology health (`TopologyInspectable`)

For service harnesses the case job is only the driver — the thing that actually fails is the warm topology.
`ServiceTopologyBackend` implements `inspectTopology(harness, tenant) → TopologyStatus` and
`topologyServiceLogs(harness, service, tenant)` (one service's log tail), backed by new optional
`TopologyRuntime` reads implemented by all three runtimes (Nomad alloc TaskStates · K8s pod statuses via
`Kubectl.podStatuses`/`logs`/`objectEvents` · Docker `ps`/`logs`). The roster is the DECLARED units (services
AND dependency stores, with `role`/`image`/`port`) unioned with the LIVE state — per unit: state, readiness,
restart churn, OOM, node, resource ask, age, the warm `endpoint`, and the orchestrator event feed (the
STRUCTURED promotion of the old timeout-only `diagnose()` string); a declared unit nothing carries rosters
honestly as `absent`. Surfaces: `GET /runs/:id/topology` +
`GET /runs/:id/topology/services/:service/logs` + MCP `get_run_topology`/`get_topology_service_logs` + the
run detail's "Service topology" panel (roster + per-row on-demand log fold; self-null for non-service runs).

### The session pool (`TopologyStatus.pool`)

For a session-acquired target the resource that bounds a batch is not a cluster unit — it is a pool of browsers
INSIDE a service container, which no orchestrator read can see. The symptom is a roster that says "the service is
running" while case after case is refused, so the operator has nothing to reason from. A harness declares where the
service reports itself (`target.acquire.capacity: {poll, total, used?}`) and `inspectTopology` carries it as
`pool {total, used, endpoint}` through `GET /runs/:id/topology` / MCP / the run detail's topology panel, which flags
saturation.

Deliberately monitoring, not admission control: `Backend.capacity()` is keyed per backend, not per harness, so the
Scheduler still admits a batch against a number unrelated to the pool. Live-drilled at both ends — a batch inside
the pool runs clean with the pool visible (peak 3/4), and a batch wider than it saturates (4/4) and fails its
overflow with `CAPACITY_EXCEEDED` rather than queueing. Making the Scheduler pool-aware needs a harness-keyed
capacity signature across every backend; until then the read is what closes the diagnostic gap.

### Failure evidence retention (`CaseFailure.placement`/`logTail`)

The orchestrator job (and its raw log) is deleted/GC'd right after settlement — post-mortem evidence must be
captured AT THROW TIME. Nomad (`waitForAlloc` failure paths, `parseResultOrExplain`) and K8s (`waitForJob`)
now attach `extra.placement {unit, node, events[]}` + `extra.logTail` (stderr-preferred, sentinel-stripped,
16 KB tail cap) to the thrown `UpstreamError`; `classifyFailure` lifts both onto the `CaseFailure`, and the
batch path's synthesized failed `CaseResult` carries the log tail as a `log` trace event — so the sealed
trajectory keeps the evidence after the cluster has long forgotten the job.

### Infra-plane trace recording (the record, not just the read)

The placement/topology reads above are LIVE — once the orchestrator GC's the job they have nothing left to
answer with. The record half: every dispatch now APPENDS the infra plane to the result's trace as `infra`
TraceEvents (`scope placement | service`), so it seals with the trajectory and survives the cluster:

- Nomad/K8s dispatch: `submitted` → blocked verdicts (as they are first seen) → `placed` (unit + node) → the
  orchestrator's own task/pod events with their REAL timestamps (event time − dispatch t0), on success AND
  failure (`failedCaseResult` renders `CaseFailure.placement.events` as infra events ahead of the log tail).
- `ServiceTopologyBackend` appends the topology roster at case completion (per unit: role/status/restarts/OOM/
  node) — "what stack did this case actually run against" is evidence, not archaeology.
- Consumers: judges/sinks ignore the kind (same contract as `log`); the web timeline and the trace browser
  render it (`[placement] Started: Task started by client @node`).

Live-verified on Nomad 2.0.3: a succeeded run's sealed trajectory carried
`submitted → Received → Task Setup → placed(alloc, node) → Started → Terminated(Exit 0)` and a pull-denied
run carried the full docker denial message — both readable from `GET /runs/:id/trajectory` after the job was gone.
