---
kind: wiki
title: "Your first scorecard"
status: current
updated: 2026-09-15
anchors: [apps/api/src/api/scorecard/request/run-scorecard.ts, packages/contracts/src/harness/harness-template.ts, examples/quickstart/harness.json, examples/quickstart/dataset.json, examples/runtimes/local-1.0.0.json]
---
# Your first scorecard

A single run tells you what happened once. A **scorecard** produces a verdict: one dataset × one
harness, every case scored the same way, aggregated into a number you can compare against the next one.

The fastest path is to register one that already works.

## Five minutes, no API key

With the `dev` stack up ([Quickstart](quickstart.md)), from the repository root:

```bash
H='content-type: application/json'
# ① where it runs — in-process on the API container (dev only)
curl -XPOST localhost:8787/runtimes          -H "$H" -d @examples/runtimes/local-1.0.0.json
# ② the agent — a template (the shape), then an instance of it (what a scorecard names)
curl -XPOST localhost:8787/harness-templates -H "$H" -d @examples/quickstart/harness.json
curl -XPOST localhost:8787/harnesses         -H "$H" -d '{
  "template": { "id": "demo-agent", "version": "1.0.0" },
  "id": "demo-agent", "version": "1.0.0", "pins": {} }'
# ③ the problems
curl -XPOST localhost:8787/datasets          -H "$H" -d @examples/quickstart/dataset.json
# ④ the batch
curl -XPOST localhost:8787/scorecards        -H "$H" -d '{
  "dataset": { "id": "demo-smoke", "version": "latest" },
  "harness": { "id": "demo-agent", "version": "latest" },
  "runtime": "local" }'
```

The last call answers `202` with the queued scorecard record. Poll `GET /scorecards/{id}` until
`status` is `succeeded`; its `verdictSummary` should read 2 passed of 2 verdicted.

No model, no provider key, no judge. The demo harness is a shell command and the graders are `grep`, so
what you just verified is the *plumbing* — that a harness registers, a dataset registers, a batch runs
every case, and a verdict comes out the other end.

`examples/quickstart/` holds the two documents: `harness.json` (a `command` template) and
`dataset.json` (two `repo` cases).

:::tip
Keep this working evaluation around. When something later breaks, running it tells you in ten seconds
whether the problem is your agent or your install.
:::

## Now make it real

### 1 — point it at your agent

Copy `harness.json` and change `command` (and the ids). Everything else stays:

```json
{
  "kind": "command",
  "category": "cli-agent",
  "id": "my-agent",
  "version": "1",
  "command": "my-agent --prompt {{task}} < /dev/null",
  "model": "claude-sonnet-5",
  "trace": { "kind": "none" }
}
```

Register it with `POST /harness-templates`, then register an instance of it with `POST /harnesses`
exactly as in ②. `{{task}}` is where the case's instruction is substituted, already shell-quoted.
`< /dev/null` matters more than it looks — run through a pipe rather than a TTY, an agent that waits for
stdin will hang until the timeout.

### 2 — write cases that can fail

```json
{
  "id": "add-retry",
  "env": { "kind": "repo", "source": { "files": {
    "client.py": "import requests\n\ndef fetch(u):\n    return requests.get(u)\n"
  } } },
  "task": "Add exponential-backoff retry to fetch(), max 3 attempts. Keep the signature.",
  "graders": [{ "id": "tests-pass", "config": { "cmd": "pytest -q" } }],
  "timeoutSec": 300,
  "tags": ["python"]
}
```

A case every agent passes is measuring nothing. If your first dataset comes back 100%, it is too easy —
that is a finding, not a success.

### 3 — run it more than once

```bash
curl -XPOST localhost:8787/scorecards \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "dataset": { "id": "my-dataset", "version": "latest" },
  "harness": { "id": "my-agent",   "version": "latest" },
  "runtime": "local",
  "trials":  3
}'
```

Three attempts per case. If a case passes twice and fails once, a single-trial scorecard was always
going to report one of those at random — and you would have spent a week explaining a regression that
was a coin flip.

### 4 — compare

```bash
curl 'localhost:8787/scorecards/diff?baseline=<baseline-id>&candidate=<candidate-id>' \
  -H 'x-everdict-tenant: default'
```

This is the call that makes the whole exercise worth it, and the one a CI gate makes.

## Submit options worth knowing

`runtime` is required: a registered runtime id, `self:<runner-id>` for your own machine, a
comma-separated list to shard the batch, or `auto` for every registered runtime. `judges[]` applies
Agent Judges to each trace. `cases` runs part of the dataset by `ids`, `tags` or `limit`. `graders[]`
replaces the dataset's graders for one batch. `criticalCases[]` (`{ "caseId" }` or `{ "prefix" }`) names
cases a release gate blocks on regardless of significance or regression budget. `concurrency` and
`retries` shape throughput and transient-failure policy.

## Read the result honestly

```json
{ "verdictSummary": { "passed": 41, "failed": 9, "verdicted": 50, "passRate": 0.82 } }
```

If `verdicted` is less than your case count, the rest were **not evaluated** — not failed. Find out why
before you draw a conclusion from `passRate`. See [Verdict](../concepts/verdict.md).

## Next

- [Bring your own agent](bring-your-agent.md) — the on-ramp per agent kind
- [Connect an agent](connect-an-agent.md) — drive all of this from Claude Code or CI
- [Scorecard](../concepts/scorecard.md) — what gets sealed into the record
