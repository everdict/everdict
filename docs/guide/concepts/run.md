---
kind: wiki
title: "Run"
status: current
updated: 2026-08-11
---
# Run

A Run is one execution, recorded. Submit one:

```bash
curl -XPOST localhost:8787/runs \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "harness": { "id": "scripted", "version": "latest" },
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
{ "runId": "run_7bf1c204" }
```

That is the shape of everything here: **submission is asynchronous**. You get an id immediately and
poll, subscribe to a webhook, or watch it in the web app.

```bash
curl localhost:8787/runs/run_7bf1c204 -H 'x-everdict-tenant: default'
```

This is not an implementation detail to skim past. An agent evaluation can take a long time, and
nothing in the system assumes a request stays open for it.

## The lifecycle

`queued → running → succeeded | failed`, plus `suspended` for a run parked on something — a human
approval, most often — rather than finished. A suspended run has not failed; treating it as failure is
a mistake the API deliberately makes hard.

## Run is the universal record

An eval case, an agent turn, a file execution, a scheduled batch's child — they all land as runs. There
is one place to ask "what happened, when, caused by whom, at what cost", and one list to look at.

Every run carries an `origin` describing what caused it: a person, CI, a schedule, a subscription
reacting to an event, a product version arriving. That field is what makes the product timeline's
x-axis possible — a trend of "how did we score on each shipped version" is only reconstructable because
each run remembers why it exists.

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
Runtime            local · nomad · k8s · self:<id>
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

Which backend a run lands on comes from the runtime you registered:

```json
{ "harness": { "id": "codex", "version": "latest" },
  "runtime": "self:rnr_8812",
  "case": { "…": "…" } }
```

`self:<id>` sends it to your own machine, where your own login pays for the tokens.

## Evidence, not an exit code

A run's value is what it leaves behind:

- **Trace** — the normalized `TraceEvent` stream plus OTel spans. Every number a judge produced can be
  walked back to the events it read.
- **Snapshot** — what changed in the world. For a repo environment that is a git diff, not a copy, so a
  grader can ask what the agent actually touched.
- **Cost and tokens** — from the harness's own trace, never estimated.
- **Failure classification** — a closed vocabulary (OOM, timeout, infra). Note what is *not* in it:
  "flaky" is a judgment, and the record stores facts.

Heavy media is offloaded to an artifact store and referenced, so the record stays small enough to list.

:::tip
Watch a long run while it runs rather than waiting for it — the live trace shows tool calls as they
happen, which is usually how you notice the agent has gone into a loop. See
[`../../architecture/live-observability.md`](../../architecture/live-observability.md).
:::

## See also

- [Scorecard](scorecard.md) — many runs, one comparable result
- [`../../architecture/execution-model.md`](../../architecture/execution-model.md) — Run as the universal record
- [`../../execution-backends.md`](../../execution-backends.md) — Backend vs Driver, scheduling, trust zones
