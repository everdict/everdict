# Run

A **Run is one execution, recorded**. It is also the platform's *universal* execution record: an eval
case, an agent turn, a command — they all land as runs, so there is one place to look for "what
happened, when, driven by whom, at what cost."

## The lifecycle

`queued → running → succeeded | failed`, with `suspended` for a run that is parked (waiting on a human
approval, for example) rather than finished.

Submission is **asynchronous** everywhere. `POST /runs` returns a `runId` immediately; you poll
`GET /runs/{id}`, subscribe to a webhook, or watch it live in the web app. This is not an
implementation detail you can ignore — an agent evaluation can take a long time, and nothing in the
system assumes a request stays open for it.

## What one run separates

Inside the sandbox, four concerns stay apart:

- **Harness** — the agent under test ([Harness](harness.md))
- **Environment** — the world it acts on: a seeded repo with a git-diff snapshot at the end, a browser,
  an OS session
- **Driver** — in-sandbox compute; the thing that actually starts the process. `ComputeHandle` is always
  released in a `finally`, so a crashed grader cannot leak a container.
- **Grader** — how the result becomes a measurement ([Grader & Judge](grader-and-judge.md))

## Where a run goes

*Placement* is a separate layer from compute, and the distinction is worth internalizing early:

| Layer | Question it answers | Examples |
| --- | --- | --- |
| **Backend** | **where** does this job run? | Local, Nomad, Kubernetes, your own runner |
| **Driver** | **how** is the process started once it is there? | `LocalDriver` in the already-isolated job |

A Backend never runs the harness itself. It dispatches the `@everdict/job-runner` image and parses that
job's result off a stdout sentinel. Isolation is the orchestrator's — a Kubernetes `runtimeClassName`,
a Nomad task driver — not something Everdict re-implements.

Which backend a run lands on comes from the **runtime** you registered (`local`, `nomad`, `k8s`) or from
`self:<id>` for a self-hosted runner. Scheduling on top of that is capacity-aware and tenant-fair, with
queueing, backpressure, circuit breaking, and queue-depth autoscaling.

## Evidence

A run's value is its evidence, not its exit code:

- **Trace** — the normalized `TraceEvent` stream, plus spans for the OTel-shaped view. Every number a
  judge produces can be walked back to the events it read.
- **Snapshot** — what changed in the world (for a repo environment, the git diff).
- **Cost and tokens** — taken from the harness's own trace, not estimated.
- **Failure classification** — when a run fails, *why* is a closed vocabulary (OOM, timeout, infra),
  because "flaky" is a judgment and the record only stores facts.

Heavy media is offloaded to an artifact store and referenced, so the record stays small enough to list.

## Runs you did not submit by hand

Runs also arrive from schedules (cron regression monitoring), from CI triggers, from subscriptions
reacting to a platform event, and from an agent acting in a conversation. All of them produce the same
record, with an `origin` describing what caused it — which is what makes the product timeline's x-axis
possible.

## Where this shows up next

- [`../../architecture/execution-model.md`](../../architecture/execution-model.md) — Run as the universal record
- [`../../execution-backends.md`](../../execution-backends.md) — Backend vs Driver, scheduling, trust zones
- [`../../orchestration.md`](../../orchestration.md) — durable batches on Temporal
- [Scorecard](scorecard.md) — many runs, one comparable result
