---
kind: wiki
title: "Schedules & monitoring"
status: current
updated: 2026-09-15
anchors: [apps/api/src/api/schedule/request/create-schedule.ts, apps/api/src/api/schedule/request/shared.ts, apps/api/src/composition/schedule.ts, apps/api/src/api/queue/queue.routes.ts]
---
# Schedules & monitoring

A scorecard you run by hand tells you about today. A regression is something that happens while nobody
is looking.

```bash
curl -XPOST localhost:8787/schedules \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "nightly retrieval",
  "cron": "0 3 * * *",
  "timezone": "Asia/Seoul",
  "runTemplate": {
    "dataset": { "id": "retrieval-smoke", "version": "latest" },
    "harness": { "id": "my-agent",        "version": "latest" },
    "trials":  3
  }
}'
```

Every night it produces a scorecard, and every scorecard is comparable to the one before it because the
dataset version and the harness version are recorded on each.

:::warning
A schedule **fires only on a control plane with Temporal** (`EVERDICT_TEMPORAL_ADDRESS` — the `full`
stack). Without it, schedules are stored and editable but nothing fires them on the clock; the
`dev` and `prod` Compose stacks are in that state. `POST /schedules/:id/fire` runs one by hand either way.
:::

## Three things a schedule can drive

A schedule is not only "run a scorecard". Its `runTemplate` picks exactly one of three:

**A scorecard** — `dataset` + `harness` (with optional `judges`, `runtime`, `trials`, `cases`), the case
above.

**A trace pull** — `pull: { source, windowHours, correlate?, scope? }` fetches the traces of a rolling
window from a registered observability platform and scores them. Nothing is executed; the agent already
ran, in production, and this is the nightly judgment of what it did.

```json
{ "name": "score last night's prod traces", "cron": "0 4 * * *",
  "runTemplate": { "pull": { "source": "mlflow-prod", "windowHours": 24,
                             "correlate": "tag", "scope": "checkout-agent" } } }
```

**A report** — `report: { view, instructions?, compare? }` has the workspace agent re-read a saved
[view](views.md) and write up what moved (needs the agent service connected to the control plane).

```json
{ "name": "monday retrieval report", "cron": "0 9 * * 1",
  "runTemplate": { "report": { "view": "vw_retrieval30", "compare": "previous-period" } } }
```

`enabled: false` pauses without deleting. `timezone` is IANA and defaults to `UTC` — worth setting, or
your "nightly" runs at a time nobody agreed to. `overlapPolicy` (`skip` by default, `bufferOne`,
`allowAll`) says what happens when the previous fire has not finished.

## Durability is the point

On Temporal, a scheduled batch is a durable workflow. A 400-case scorecard that starts at 03:00 and is
interrupted at 03:40 by a deploy **resumes** rather than starting over or silently reporting a partial
result.

That property is what makes an unattended schedule trustworthy, and it is worth understanding rather
than assuming — see [Durability & Temporal](durability.md).

## Watch the right thing

Three questions, three places:

**Is it running?** The work queue (`GET /queue`) shows running, waiting and next-scheduled work per
runtime lane — which is where you look when "the nightly did not happen".

**Did it move?** The scorecard diff against the previous run. A schedule that produces numbers nobody
diffs is a cron job that burns tokens.

**Is the movement real?** With `trials`, you can see the spread. Before calling a difference a
regression, check that it is larger than the noise between two runs of the *same* version.

:::warning
Schedules cost money on a timer. A nightly 400-case batch with two judges is a nightly provider bill.
A workspace budget can cap it — past the cap, new runs are refused, including the rest of a batch
already under way — so decide which failure you prefer before the invoice decides for you. See
[Budgets & cost](budgets.md).
:::

## See also

- [Notifications](notifications.md) — being told instead of checking
- [`../../architecture/scheduled-evals.md`](../../architecture/scheduled-evals.md) · [`../../orchestration.md`](../../orchestration.md)
