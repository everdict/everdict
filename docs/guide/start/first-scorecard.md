# Your first scorecard

A single run tells you what happened once. A **scorecard** produces a verdict: one dataset × one
harness, every case scored the same way, aggregated into a number you can compare against the next one.

The fastest path is to clone one that already works.

## Five minutes, no API key

```bash
docker compose -f deploy/compose/docker-compose.dev.yaml up --build -d
bash examples/quickstart/run.sh
```

```
① registering harness   demo-agent@1.0.0
② registering dataset   demo-smoke@1.0.0
③ running scorecard     sc_…
   waiting … succeeded
④ verdict               2/2 passed (passRate 1)
```

No model, no provider key, no judge. The demo harness is a shell command and the graders are `grep`, so
what you just verified is the *plumbing* — that a harness registers, a dataset registers, a batch runs
every case, and a verdict comes out the other end.

The three files in `examples/quickstart/` are the whole thing: `harness.json`, `dataset.json`, and the
script that submits them.

:::tip
Keep this working evaluation around. When something later breaks, running it tells you in ten seconds
whether the problem is your agent or your install.
:::

## Now make it real

### 1 — point it at your agent

Edit `harness.json`. Everything except `command` stays:

```json
{
  "kind": "command",
  "id": "my-agent",
  "version": "1.0.0",
  "command": "my-agent --prompt {{task}} < /dev/null",
  "model": "claude-sonnet-5",
  "trace": { "kind": "none" }
}
```

`{{task}}` is where the case's instruction is substituted. `< /dev/null` matters more than it looks —
run through a pipe rather than a TTY, an agent that waits for stdin will hang until the timeout.

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
  "trials":  3
}'
```

Three attempts per case. If a case passes twice and fails once, a single-trial scorecard was always
going to report one of those at random — and you would have spent a week explaining a regression that
was a coin flip.

### 4 — compare

```bash
curl 'localhost:8787/scorecards/diff?baseline=sc_aaa&candidate=sc_bbb' \
  -H 'x-everdict-tenant: default'
```

This is the call that makes the whole exercise worth it, and the one a CI gate makes.

## Submit options worth knowing

`judges[]` applies Agent Judges to each trace. `runtime` picks where it runs (`self:<id>` for your own
machine). `subset` runs part of the dataset by `ids`, `tags` or `limit`. `graders[]` overrides the
dataset's graders for one batch. `criticalCases[]` names cases whose failure fails the batch regardless
of the rate. `concurrency` and `retries` shape throughput and transient-failure policy.

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
