---
kind: wiki
title: "Analysis & views"
status: current
updated: 2026-08-11
---
# Analysis & views

After a few weeks you have hundreds of scorecards, and the same three questions every Monday.

A **view** saves the question, not the answer. It stores a lens over the scorecard list — filters,
dimensions, grouping — and **re-runs live when opened**, so it is never stale.

```bash
curl -XPOST localhost:8787/views \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "retrieval by model, last 30 days",
  "visibility": "workspace",
  "config": {
    "filters":    { "dataset": ["retrieval-smoke"], "from": "-30d" },
    "dimensions": ["harnessVersion", "model"],
    "metric":     "passRate"
  }
}'
```

`private` keeps it to you; `workspace` shares it. Editing and deleting are creator-or-admin. Views
reuse the scorecard permissions rather than inventing their own, so nobody can see through a view what
they could not see directly.

## Dimensions worth pivoting on

`dataset` · `datasetVersion` · `harness` · `harnessVersion` · `model` · `judgeModel` · `status` ·
`originSource` · `repo` · `owner` · `day` · `week` · `month`.

**`model` and `judgeModel` are separate on purpose.** One is the agent's model, the other is the
judge's. Mixing them is how a team concludes their agent improved when in fact they upgraded the judge.

**`originSource`** separates what caused the run — a person, CI, a schedule, a shipped product version.
A trend that mixes hand-run experiments with nightly monitoring is two trends drawn on one line.

## The leaderboard

Model is a first-class dimension, so `harness × model × benchmark` ranks as distinct rows. Swapping the
model produces a *new row* rather than overwriting the old number — which is what makes "was
sonnet-5 better than opus-5 on our data" a question with a stored answer.

## When a comparison is not a comparison

Before trusting a pivot, check the seal. `POST /scorecards/:id/verify-manifest` reports `drifted` when
the document a batch evaluated is no longer what that id resolves to today. A chart that puts a drifted
scorecard next to a fresh one is comparing two different benchmarks with the same name.

## See also

- [Scorecard](../concepts/scorecard.md) — what is sealed into each row
- [`../../architecture/scorecard-analysis-views.md`](../../architecture/scorecard-analysis-views.md)
