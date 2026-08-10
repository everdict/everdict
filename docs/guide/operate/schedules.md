# Schedules & monitoring

A scorecard you run by hand tells you about today. A regression is something that happens while nobody
is looking.

```bash
curl -XPOST localhost:8787/schedules \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "nightly retrieval",
  "cron": "0 3 * * *",
  "timezone": "Asia/Seoul",
  "scorecard": {
    "dataset": { "id": "retrieval-smoke", "version": "latest" },
    "harness": { "id": "my-agent",        "version": "latest" },
    "trials":  3
  }
}'
```

Every night it produces a scorecard, and every scorecard is comparable to the one before it because the
dataset version and the harness version are recorded on each.

## Durability is the point

Scheduled batches run on Temporal. That is not an implementation detail you can ignore: a 400-case
scorecard that starts at 03:00 and is interrupted at 03:40 by a deploy **resumes** rather than starting
over or silently reporting a partial result.

Workflow code stays deterministic and side effects live in activities, which is what makes the resume
correct rather than approximate.

## Watch the right thing

Three questions, three places:

**Is it running?** The work queue shows running, queued and next-scheduled per runtime lane — which is
where you look when "the nightly did not happen".

**Did it move?** The scorecard diff against the previous run. A schedule that produces numbers nobody
diffs is a cron job that burns tokens.

**Is the movement real?** With `trials`, you can see the spread. Before calling a difference a
regression, check that it is larger than the noise between two runs of the *same* version.

:::warning
Schedules cost money on a timer. A nightly 400-case batch with two judges is a nightly provider bill.
Budgets are per workspace and meter-only — they record spend, they do not refuse it — so put a number
on it and look at it.
:::

## See also

- [Notifications](notifications.md) — being told instead of checking
- [`../../architecture/scheduled-evals.md`](../../architecture/scheduled-evals.md) · [`../../orchestration.md`](../../orchestration.md)
