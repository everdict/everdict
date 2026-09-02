---
kind: wiki
title: "Scorecard"
status: current
updated: 2026-08-11
---
# Scorecard

A scorecard is one dataset × one harness, every case run and scored the same way:

```bash
curl -XPOST localhost:8787/scorecards \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "dataset": { "id": "retrieval-smoke", "version": "latest" },
  "harness": { "id": "my-agent",        "version": "1.4.0" },
  "judges":  [{ "id": "tone-rubric",    "version": "latest" }],
  "trials":  3,
  "concurrency": 8
}'
```

```json
{ "scorecardId": "sc_91f2ab" }
```

A run tells you what happened once. A scorecard answers "is this version good" — and paired with a
second one, "did it get better":

```bash
curl 'localhost:8787/scorecards/diff?baseline=sc_7c01&candidate=sc_91f2ab' \
  -H 'x-everdict-tenant: default'
```

The diff matches cases by id and names regressions and improvements individually. This is the call a
CI gate makes: block the pull request when a case that used to pass now fails.

## Trials, and why one run per case is not enough

```json
{ "dataset": { "id": "retrieval-smoke", "version": "latest" },
  "harness": { "id": "my-agent", "version": "1.4.0" },
  "trials": 5 }
```

Each case is attempted five times. An agent that solves a case 3 times in 5 is a different product from
one that solves it 5 times in 5, and a single-trial scorecard cannot tell them apart — it will report
one of them as a pass and the other as a fail, at random.

Trials are the input to pass@k and to flakiness detection. Before you call a difference between two
versions real, you need to know the noise floor, and trials are how you measure it.

## What gets sealed into the record

Beyond per-case results and the summary, a scorecard pins everything a comparison depends on:

**The exact versions evaluated** — dataset version, harness version, resolved pins. A submit-time
ephemeral image swap is recorded in `origin.pinOverrides`, so the record names what actually ran, not
what was registered.

**The verdict policy** — composed at submit and stamped with a digest. The rules that decided pass and
fail travel with the result, so reading a six-month-old scorecard tells you what "pass" meant *then*.

**A manifest seal** — a content digest per facet: cases, the grading plan, and each judge's model,
rubric and harness closure.

```bash
curl -XPOST localhost:8787/scorecards/sc_91f2ab/verify-manifest \
  -H 'x-everdict-tenant: default'
```

Each facet comes back `match`, `drifted`, `missing` or `unverifiable`. **`drifted` is the one to care
about**: it means the document this batch evaluated is no longer what that id resolves to today — so
the comparison you were about to make is not the one you think it is.

**A scoring ledger** — every judged settle appends a `ScoringRevision` with a digest of the whole score
plane. Re-scoring is legal; silently changing what a past decision rested on is not.

## Scoring runs that happened elsewhere

You do not need Everdict to have executed the agent.

**Push** what you already have:

```bash
curl -XPOST localhost:8787/scorecards/ingest \
  -H 'content-type: application/json' -d '{
  "dataset": { "id": "retrieval-smoke", "version": "latest" },
  "judges": [{ "id": "tone-rubric", "version": "latest" }],
  "traces": [{ "caseId": "add-retry", "events": [ … ] }]
}'
```

**Pull** from the observability platform your team already uses:

```bash
curl -XPOST localhost:8787/scorecards/ingest/pull \
  -H 'content-type: application/json' -d '{
  "source": "mlflow-prod",
  "dataset": { "id": "retrieval-smoke", "version": "latest" },
  "judges": [{ "id": "tone-rubric", "version": "latest" }]
}'
```

When the source kind matches, scores are **attached to the original traces** rather than duplicated —
the eval shows up where your team already looks. The reverse direction exists too: a trace sink exports
judged detail back out. A sink failure never fails the scorecard; the outcome is recorded on the record.

## Saved views

The web app stores lenses over the scorecard list — filters, dimensions, groupings — that re-run live
when opened, so a recurring question does not have to be re-specified every Monday. Views reuse the
scorecard permissions rather than inventing their own.

## Scorecards are not an end in themselves

A scorecard is what an **issue** cites when it closes ("this resolution is proved by that scorecard"),
what a **release gate** refuses to ship over when a series regressed, and what a **schedule** produces
on a cron for regression monitoring.

An issue that cites the scorecard which proved it can reopen itself as `regressed` when that proof
stops holding. That loop is the reason to produce the number at all.

## See also

- [Verdict](verdict.md) — what the aggregate means, and what it refuses to mean
- [`../../scorecards.md`](../../scorecards.md) — the full reference
- [`../../tracker.md`](../../tracker.md) — issues and initiatives that cite scorecards
