# Scorecard

A **Scorecard is a batch evaluation**: one dataset × one harness, every case run and scored the same
way, aggregated into a result you can compare against another scorecard.

A run answers "what happened once." A scorecard answers "is this version good," and — paired with a
second scorecard — "did it get better."

## What it records

Beyond the per-case results and the summary, a scorecard pins the things a comparison depends on:

- **The exact versions evaluated** — dataset version, harness version, and the resolved pins. If a
  submit-time ephemeral image swap happened (a CI run on a candidate build), it is recorded in
  `origin.pinOverrides`, so the record names what actually ran and not what was registered.
- **The verdict policy** — composed at submit and stamped. The rules that decided pass/fail travel with
  the result rather than being re-derived later.
- **A manifest seal** — a content digest per facet (cases, grading plan, each judge's model/rubric/
  harness closure). `POST /scorecards/:id/verify-manifest` re-checks each facet against the registry
  today and reports `match` / `drifted` / `missing` / `unverifiable`. "Drifted" means the document this
  batch evaluated is no longer what that id resolves to — the comparison you were about to make is not
  the one you think.
- **A scoring ledger** — every judged settle appends a `ScoringRevision` (append-only) with a digest of
  the whole score plane. Re-scoring a scorecard is legal, but it can never silently change what a past
  decision was based on.

## Trials, flakiness, and pass@k

A submit can ask for `trials: N` — each case run N times. That is the input to pass@k and to
flakiness detection, which matter more than most teams expect: an agent that solves a case 3 times in 5
is a different product from one that solves it 5 times in 5, and a single-trial scorecard cannot tell
them apart.

## Comparing two scorecards

```
GET /scorecards/diff?baseline=<id>&candidate=<id>
```

The diff matches cases by `id` and names regressions and improvements individually. This is the API a
CI gate calls: block the pull request when a case that used to pass now fails.

The web app adds saved **Views** — stored lenses over the scorecard list (filters, dimensions,
groupings) that re-run live when opened, so a recurring question does not have to be re-specified.
Views reuse the scorecard permissions rather than introducing their own.

## Scoring something Everdict did not run

Two ingest paths exist for runs that happened elsewhere:

- **push** — `POST /scorecards/ingest` with a `TraceEvent[]` you already have. No harness run occurs;
  the judges score the trace.
- **pull** — `POST /scorecards/ingest/pull` fetches traces from the workspace's registered
  observability platform (OTel, MLflow, Langfuse, LangSmith, Phoenix) and scores those.

When the pull source matches the platform's kind, the scores are **attached to the original traces**
rather than duplicated — the eval shows up where your team already looks.

The reverse direction exists too: a **trace sink** exports judged detail back out to the team's
platform. A sink failure never fails the scorecard; the outcome is recorded on the record instead.

## Where scorecards get used

They are not an end in themselves. A scorecard is what an **issue** cites when it closes ("this
resolution is proved by that scorecard"), what a **release gate** refuses to ship over when a series
regressed, and what a **schedule** produces on a cron for regression monitoring.

## Where this shows up next

- [Verdict](verdict.md) — what the aggregate number means, and what it refuses to mean
- [`../../scorecards.md`](../../scorecards.md) — the full reference
- [`../../architecture/scorecard-analysis-views.md`](../../architecture/scorecard-analysis-views.md) — analysis and saved Views
- [`../../tracker.md`](../../tracker.md) — issues, projects, and initiatives that cite scorecards
