# Your first scorecard

A single run tells you what happened once. A **scorecard** is the unit that produces a verdict: one
dataset × one harness, every case scored the same way, aggregated into a number you can compare against
the next one.

This page assumes the stack is up ([Quickstart](quickstart.md)).

## The three things a scorecard needs

1. **A dataset** — the eval cases. Harness-agnostic: a case describes the task and the world, never the
   agent. See [Dataset](../concepts/dataset.md).
2. **A harness** — the agent under test, registered as a versioned `HarnessSpec`. See
   [Harness](../concepts/harness.md).
3. **Graders, and optionally judges** — how each case is scored. Graders come from the dataset case or
   the submit; judges are applied to the trace afterwards. See
   [Grader & Judge](../concepts/grader-and-judge.md).

All three are registered in the versioned registry as `(workspace, id, version)`. Versions are
immutable — this is what makes two scorecards comparable at all.

## Register a harness

The fastest harness to register is a **declarative `command` harness**: a JSON spec naming an
executable and how to read its output, no code adapter. The repository ships reference specs under
`examples/harness-templates/`.

```bash
curl -XPOST localhost:8787/harnesses \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d @examples/harness-templates/aider-litellm.template.json
```

`GET /harnesses` lists what the workspace owns plus the `_shared` fallbacks.

## Register a dataset

A dataset is a bundle of `EvalCase`s. Each case carries an `id`, the `env` it runs in, the `task`, the
`graders` that score it, and a `timeoutSec`:

```json
{
  "id": "smoke",
  "version": "1.0.0",
  "cases": [
    {
      "id": "write-file",
      "env": { "kind": "repo", "source": { "files": {} } },
      "task": "Create ok.txt containing the text done",
      "graders": [{ "id": "tests-pass", "config": { "cmd": "grep -q done ok.txt" } }],
      "timeoutSec": 120,
      "tags": ["smoke"]
    }
  ]
}
```

`POST /datasets` with that body. Reference bundles live in `examples/datasets/`.

## Run the batch

```bash
curl -XPOST localhost:8787/scorecards \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "dataset": { "id": "smoke", "version": "latest" },
  "harness": { "id": "my-agent", "version": "latest" },
  "judges":  [],
  "trials":  1
}'
```

Useful fields on the submit:

| Field | What it does |
| --- | --- |
| `judges[]` | Agent Judges applied to each trace → `judge:<id>` scores |
| `trials` | run each case N times — the input to pass@k and flakiness |
| `runtime` | which registered runtime places the jobs (`self:<id>` for your own machine) |
| `concurrency`, `retries` | batch throughput and transient-failure policy |
| `subset` | run only some cases — by `ids`, by `tags`, or a `limit` |
| `graders[]` | override the dataset's graders for this batch |
| `criticalCases[]` | cases whose failure fails the batch regardless of the rate |

Submission is asynchronous: you get a scorecard id back and poll `GET /scorecards/{id}`, or watch it in
the web app.

## Read the result

A finished scorecard carries the per-case results, the aggregate summary, and a **verdict summary**
computed under the policy that was stamped at submit time. Read
[Verdict](../concepts/verdict.md) before trusting the number — in particular, cases that were never
evaluated are *not* counted as passing.

## Compare it against the last one

This is the part that makes the number worth producing:

```
GET /scorecards/diff?baseline=<id>&candidate=<id>
```

The diff names regressions and improvements case by case, so "did it get better" has an answer that
does not depend on who is reading.

## Next

- [Connect an agent](connect-an-agent.md) — drive all of this from Claude Code or CI over MCP
- [Scorecard](../concepts/scorecard.md) — what the record actually contains, and what is sealed into it
- [`../../scorecards.md`](../../scorecards.md) — the full reference, including trace ingest and re-scoring
