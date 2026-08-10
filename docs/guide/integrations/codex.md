# Running Codex

Codex is supported as an **agent under test**, not as a driver.

There is no Codex plugin — the integration path is a declarative `command` harness, which is how any
CLI agent joins Everdict. No adapter code, no package, just a spec:

```json
{
  "kind": "command",
  "category": "cli-agent",
  "id": "codex",
  "version": "1",
  "setup": [],
  "command": "codex exec --sandbox workspace-write --skip-git-repo-check {{task}} < /dev/null",
  "model": "gpt-5-codex",
  "env": {},
  "trace": { "kind": "none" }
}
```

Three details in that command are worth stealing for any CLI agent:

- **`{{task}}`** is where the case's task text is substituted.
- **`< /dev/null`** gives the process an immediate stdin EOF. Run non-interactively through a pipe
  rather than a TTY, an agent that waits for input otherwise hangs until the timeout.
- **`trace: none`** says this harness emits no trace Everdict can parse, so the run is graded on its
  **outcome** rather than its trajectory. That is a legitimate choice, not a limitation — see below.

## Run it, end to end

The repository ships this as a bundle — harness, dataset and grading as pure data:

```bash
cat examples/bundles/codex-pinch/bundle.json          # read what you are about to apply
curl -XPOST localhost:8787/bundles/apply \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d @examples/bundles/codex-pinch/bundle.json
```

Then score it:

```bash
curl -XPOST localhost:8787/scorecards \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "dataset": { "id": "pinch-dashboards", "version": "latest" },
  "harness": { "id": "codex", "version": "latest" },
  "runtime": "self:<runner-id>"
}'
```

`runtime: self:<id>` matters here: it runs Codex on **your** machine, so the ChatGPT login already on
that machine pays for the tokens and the workspace budget is untouched.

Pair a machine first — the desktop app has a one-click "Connect this device", or headless:

```bash
everdict runner --pair rnr_… --api-url http://localhost:8787
```

## Grading an agent that emits no trace

With `trace: none` there is no trajectory to judge, so the dataset grades what the agent *did*:

```json
{
  "id": "dashboard-p95",
  "env": { "kind": "repo", "source": { "files": {} } },
  "task": "Write dashboard.json with panels for p95, p99, error rate and volume.",
  "graders": [{ "id": "tests-pass", "config": { "cmd": "node validate-dashboard.mjs" } }],
  "timeoutSec": 600
}
```

Deterministic, no judge model, no provider key. This is usually the *better* eval — a judge introduces
its own variance, and "is the JSON valid and does it contain the four panels" has one right answer.

Use a judge when the output has no checkable shape (prose, a plan, a design), and a deterministic
grader whenever you can get away with it.

## Comparing Codex against another agent

That is the whole point, and it works because a [dataset](../concepts/dataset.md) is harness-agnostic —
the cases never mention the agent. Register a second harness, run the same dataset, and diff:

```bash
curl 'localhost:8787/scorecards/diff?baseline=<codex-scorecard>&candidate=<other-scorecard>' \
  -H 'x-everdict-tenant: default'
```

The model is a first-class dimension, so `codex@1.0.0 × gpt-5-codex` ranks on the leaderboard as its
own row — swapping the model produces a different row rather than overwriting the old number.

:::tip
Give a CLI agent its own `version` whenever the *command* changes, and pin the model. Two runs whose
command differs are not two runs of the same agent, and the leaderboard is only meaningful if the row
identity is honest.
:::

## See also

- [`../../command-harness.md`](../../command-harness.md) — the full `command` harness reference
- [Harness](../concepts/harness.md) — templates, instances and pins
- [`../../../examples/bundles/codex-pinch/README.md`](https://github.com/everdict/everdict/blob/main/examples/bundles/codex-pinch/README.md) — this bundle's own notes
