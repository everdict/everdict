---
kind: wiki
title: "Run"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/records/run.ts, apps/api/src/api/run/request/submit.ts, packages/contracts/src/execution/case-failure.ts, packages/contracts/src/execution/environment.ts]
---
# Run

A Run is one execution, recorded. Submit one:

```bash
curl -XPOST localhost:8787/runs \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "harness": { "id": "scripted", "version": "latest" },
  "runtime": "local",
  "case": {
    "id": "c1",
    "env": { "kind": "repo", "source": { "files": {} } },
    "task": "Create ok.txt containing the text done",
    "graders": [{ "id": "tests-pass", "config": { "cmd": "grep -q done ok.txt" } }],
    "timeoutSec": 120,
    "tags": []
  }}'
```

```json
{ "id": "3f0c9a52-…", "caseId": "c1", "status": "queued", "…": "…" }
```

That is the shape of everything here: **submission is asynchronous**. You get the queued record (`202`)
immediately and poll, pass a `webhookUrl` at submit, or watch it in the web app.

```bash
curl localhost:8787/runs/3f0c9a52-… -H 'x-everdict-tenant: default'
```

This is not an implementation detail to skim past. An agent evaluation can take a long time, and
nothing in the system assumes a request stays open for it.

## The lifecycle

`queued → running → succeeded | failed`, plus `suspended` for a run that stopped without completing and
can be resumed — an agent run that reached its budget, or one parked on a wait. A suspended run has not
failed and has not succeeded; a resume is a new run, and the suspended row stays the record of where the
work stopped.

## Run is the universal record

An eval case, an agent turn, a command, a sandbox session, a scheduled batch's child — they all land as
runs (`kind`: `eval`, `agent`, `command`, `sandbox`, `analysis`). There is one place to ask "what
happened, when, caused by whom, at what cost", and one list to look at.

Every run carries an `origin` describing what caused it — `cause` is one of `member`, `schedule`,
`event`, `run`, `ci` or `api`, with the actor and the schedule, event or parent run behind it. A trend
over time is only reconstructable because each run remembers why it exists.

## What one run separates

Inside the sandbox, four concerns stay apart. Keeping them apart is what makes the same case portable
across agents and infrastructure:

**Harness** — the agent under test. **Environment** — the world it acts on. **Driver** — the in-sandbox
compute that actually starts the process. **Grader** — how the result becomes a measurement.

`ComputeHandle` is always released in a `finally`, so a grader that throws cannot leak a container.

## Where a run goes

*Placement* is a separate layer from compute, and the distinction saves a lot of confusion later:

A **Backend** answers *where does this job run* — a Nomad cluster, a Kubernetes cluster, your laptop. A
**Driver** answers *how is the process started once it is there*.

```
POST /runs
    │
    ▼
Runtime            local · nomad · k8s · self:<runner-id>
    │
    ▼
Backend   ── WHERE ──▶  dispatches a job-runner job
    │                    isolation is the orchestrator's
    ▼
Driver    ── HOW   ──▶  starts the process in-sandbox
    │
    ▼
Harness   ── the agent under test
```

A Backend never runs the harness itself. It dispatches the `@everdict/job-runner` image and parses that
job's result off a stdout sentinel. Isolation is the orchestrator's — a Kubernetes `runtimeClassName`,
a Nomad task driver — not something Everdict re-implements badly.

Which backend a run lands on comes from the `runtime` you name, and naming one is required — a submit
without it is a `400`:

```json
{ "harness": { "id": "codex", "version": "latest" },
  "runtime": "self:<runner-id>",
  "case": { "…": "…" } }
```

`self:<runner-id>` sends it to your own machine, where your own login pays for the tokens.

## Evidence, not an exit code

A run's value is what it leaves behind:

- **Trace** — the normalized `TraceEvent` stream. Every number a judge produced can be walked back to
  the events it read.
- **Snapshot** — what changed in the world. For a repo environment that is a git diff and the changed
  files, not a copy, so a grader can ask what the agent actually touched.
- **Cost and tokens** — from the harness's own trace, never estimated.
- **Failure classification** — a closed vocabulary: the `stage` that failed (`dispatch`, `install`,
  `run`, `collect`, `grade`) and whose fault it was (`infra`, `config`, `harness`, `agent`), plus
  whether an as-is retry has a chance. Note what is *not* in it: "flaky" is a judgment, and the record
  stores facts.

Heavy media — a full page DOM, a screenshot — is offloaded to an artifact store and referenced, so the
record stays small enough to list.

:::tip
Watch a long run while it runs rather than waiting for it — the live trace shows tool calls as they
happen, which is usually how you notice the agent has gone into a loop. See
[`../../architecture/live-observability.md`](../../architecture/live-observability.md).
:::

## See also

- [Scorecard](scorecard.md) — many runs, one comparable result
- [`../../architecture/execution-model.md`](../../architecture/execution-model.md) — Run as the universal record
- [`../../execution-backends.md`](../../execution-backends.md) — Backend vs Driver, scheduling, trust zones
