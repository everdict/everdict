# Durability & Temporal

A 400-case scorecard runs for two hours. Somewhere in that window you will deploy, a pod will be
evicted, or a machine will reboot. What happens to the batch is a product decision, and Everdict makes
it explicitly.

## Two orchestrators

**`DirectOrchestrator`** — an in-process loop. Fine for development, and the default on the `dev`
profile. On restart, in-flight work becomes ghosts: the cases may still be running on their runtimes,
but nothing knows where the batch was.

**`TemporalOrchestrator`** — each batch is a durable workflow. A restart resumes rather than restarts,
and transient backend failures retry without a human.

```bash
bash deploy/compose/full.sh        # brings up Temporal alongside Postgres and MinIO
everdict run --orchestrator temporal
everdict worker                    # the workflow worker
```

Temporal stays **optional**. Everything works without it; what you lose is the durability described
below.

## What a workflow engine actually buys

Not "workflows" — **a durable program counter.**

In an ordinary program, *where was I* — the loop index, retry counts, partial results, what comes next
— lives in RAM and dies with the process. The work itself may survive (cases keep running on runtimes);
knowing where you were does not.

Everdict climbed part of this ladder before adopting Temporal, and the notes are worth reading before
you decide you do not need it:

**Rung 0 — the in-process loop.** Restart equals ghosts.

**Rung 1 — checkpoint in the database plus a recovery sweep.** This is real and it works: the run
ledger is the checkpoint, `recoverInterrupted` adopts orphans and re-dispatches. The tax is that
**the recovery path is a second implementation of the forward path**, and it has to agree with it
forever — trials, spillover, retry classes and streaming phases each land twice.

Four things stay missing at rung 1: durable **timers** ("retry in 90s", "wait 3 days" — a scheduler
reinvented in a table), **HA safety** (two replicas both sweeping, so you hand-roll leases),
**in-flight versioning** (you deploy during a two-hour batch; the checkpoint says plan A and the new
code is plan B), and **signal delivery** (a cancel has to find the right process mid-`await`).

**Rung 2 — generalize it** for approval waits, reapers and retention, and you have written a workflow
engine minus the history and replay.

## The line between Temporal and the event plane

One sentence separates them: **does the work have a definition of done?**

Temporal owns completion-bearing plans — the batch driver and the schedule clock. The event plane owns
open-ended perception and reaction: facts, cursors, subscriptions.

Temporal fires facts and executes plans. It never routes facts or decides reactions. Keeping that
boundary is why adding a subscription does not require touching a workflow.

:::warning
Workflow code must be **deterministic** — no I/O, no clocks, no randomness. Side effects live in
activities (`dispatchCase`). A non-deterministic workflow replays differently than it ran, which turns
a resume into a wrong answer rather than an error.
:::

## What this looks like when things break

**Control plane restarts mid-batch** — the workflow resumes at the case it was on. Cases already
dispatched are adopted rather than re-run.

**A backend returns a transient error** — retried under the workflow's policy, not by a human noticing.

**A case OOMs** — classified, and with `oomAutoBoost` re-dispatched with more memory instead of being
recorded as an agent failure. The distinction matters: an infrastructure death is not evidence about
the agent, and counting it as one is how a "regression" turns out to be a cluster.

**You cancel a scorecard** — the cancellation reaches the in-flight cases and settles their ledger
rows, rather than leaving records that say `running` forever.

## Do you need it?

**No** if you run scorecards by hand, they finish in minutes, and a restart during one is an
inconvenience you can absorb by re-running.

**Yes** the moment evaluation becomes unattended — schedules, CI triggers, subscriptions — or batches
get long enough that "just run it again" costs real money. That is also the moment a partial result
reported as a complete one starts producing wrong decisions.

## See also

- [Schedules & monitoring](schedules.md) — what the schedule clock drives
- [Runtime](../concepts/runtime.md) — where the dispatched cases actually land
- [`../../orchestration.md`](../../orchestration.md) — the full reference, including the DIY ladder
- [`../../architecture/batch-resilience.md`](../../architecture/batch-resilience.md) — retry · restart-resume · retry-failed
