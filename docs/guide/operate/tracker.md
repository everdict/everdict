---
kind: wiki
title: "Track the work"
status: current
updated: 2026-08-11
---
# Track the work

Everdict has a tracker, and the reason is narrow: **an eval that nobody acts on is a number in a
table.** The tracker is the layer that says *why* you are evaluating and *what changed* when you did.

It is shaped like Linear — Initiative ⊃ Project ⊃ Issue — with one difference that matters.

## An issue closes with proof

```bash
curl -XPOST localhost:8787/issues \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "title": "Long-context retrieval drops citations",
  "description": "Cases retrieval/long-context and retrieval/citations fail above 8k tokens.",
  "links": [{ "kind": "dataset", "id": "retrieval-smoke" },
            { "kind": "harness", "id": "my-agent" }]
}'
```

When you fix it, the issue does not close because someone clicked a button. It closes citing the
scorecard that proved it:

```bash
curl -XPATCH localhost:8787/issues/iss_4d21 \
  -H 'content-type: application/json' -d '{
  "status": "done",
  "resolution": { "scorecardId": "sc_91f2ab", "note": "both cases pass at 3/3 trials" }
}'
```

And here is the part that is not decoration: **when that resolution stops holding, the issue reopens as
`regressed`.** The proof is checked, not remembered. An issue closed on a scorecard whose cases start
failing again comes back on its own, with the evidence attached.

## Projects and initiatives

A **project** groups issues toward a deliverable. An **initiative** is a **goal** several projects work
toward — not a release train, and not a folder.

Progress is live arithmetic over every issue underneath, so nobody maintains a percentage by hand. And
completing either is a **gate**:

```bash
curl -XPOST localhost:8787/projects/prj_88/complete \
  -H 'content-type: application/json' -d '{}'
# → 409, with the open issues listed
```

It refuses while issues are open. You can force it — and the force is recorded, because "we shipped
with three open issues" is a fact worth keeping rather than a state to hide.

An initiative's health and lead come from its own posted updates, the same shape projects have, so
status is something someone wrote rather than something a formula inferred.

## When not to use it

If you already run Linear or Jira and your team lives there, do not migrate. The value of Everdict's
tracker is the resolution link — an issue that knows which scorecard proved it — and if that link does
not matter to you, an issue tracker you already use is better than one you have to remember to open.

## See also

- [Scorecard](../concepts/scorecard.md) — the proof an issue cites
- [`../../tracker.md`](../../tracker.md) — the full reference
