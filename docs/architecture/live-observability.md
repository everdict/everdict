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
lease-queue lanes have no orchestrator job to read; `DockerDriver` (case.image jobs) still buffers
(follow-up if the need shows).

Live-verified on Nomad: a 2s-tick harness showed `tick 1..6` in the mid-run snapshot, `tick 7..9`
six seconds later, and the SSE stream delivered the initial chunk, incremental `tick 10`, the final
line, then `event: end {"status":"succeeded"}`.

## ③ Live trace deep-link — where the platform trace is accumulating

For harnesses that DO export a platform trace (otel/mlflow/langfuse/langsmith/phoenix), the
correlation used to be minted IN-JOB (`runCase`'s `newRunId()`), so nothing outside the job could
find the trace until the result landed. The control plane now mints it at dispatch and carries it
on the job (`AgentJob.runId`; `runCase` keeps its self-mint only as the no-CP fallback):

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
