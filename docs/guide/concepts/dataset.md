# Dataset

A dataset is the fixed set of problems you measure an agent against. Here is one with a single case:

```json
{
  "id": "retrieval-smoke",
  "version": "1.0.0",
  "cases": [
    {
      "id": "add-retry",
      "env": {
        "kind": "repo",
        "source": { "files": {
          "client.py": "import requests\n\ndef fetch(u):\n    return requests.get(u)\n",
          "test_client.py": "from client import fetch\n\ndef test_retries(monkeypatch):\n    ...\n"
        } }
      },
      "task": "Add exponential-backoff retry to fetch(), max 3 attempts. Keep the signature.",
      "graders": [{ "id": "tests-pass", "config": { "cmd": "pytest -q" } }],
      "timeoutSec": 300,
      "tags": ["python", "smoke"]
    }
  ]
}
```

```bash
curl -XPOST localhost:8787/datasets \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d @retrieval-smoke.json
```

Notice what the case does **not** contain: any mention of the agent. That is the defining property — a
dataset is **harness-agnostic**, which is what lets you run it against Claude Code, Codex and your own
CLI agent and compare the three honestly.

## The fields that matter

`id`, `env`, `task`, `graders` and `timeoutSec` are the working set. The rest earn their place when you
need them:

- **`expected`** — ground truth, for graders that compare against it.
- **`milestones`** — intermediate checkpoints, for partial credit on long tasks.
- **`image`** — the environment image, when the case needs a specific one.
- **`fixtures`** — files or data seeded before the agent starts.
- **`placement`** — a hint about where the case must run (an OS target, say).
- **`tags`** — labels, and the selector for running a subset.

:::warning
`id` is load-bearing. `GET /scorecards/diff` matches cases across scorecards **by id** — renaming a case
silently breaks its trend line, and nothing looks broken while it happens. Treat case ids the way you
treat database keys.
:::

## Running only part of it

```bash
curl -XPOST localhost:8787/scorecards \
  -H 'content-type: application/json' -d '{
  "dataset": { "id": "retrieval-smoke", "version": "latest" },
  "harness": { "id": "my-agent", "version": "latest" },
  "subset":  { "tags": ["smoke"], "limit": 20 }
}'
```

The scorecard records that it was a subset run. That matters: a pass rate over 20 of 400 cases is not
the same claim as a pass rate over 400, and a chart that mixes the two is lying quietly.

## Graders belong to the case — usually

The dataset defines what "solved" means per problem, which is why graders live on the case. Two escape
hatches exist:

**Override for one batch** — score an existing dataset a different way without forking it:

```json
{ "dataset": { "id": "retrieval-smoke", "version": "latest" },
  "harness": { "id": "my-agent", "version": "latest" },
  "graders": [{ "id": "script", "config": { "cmd": "./stricter-check.sh" } }] }
```

**Judges** — applied on top, per trace, chosen at submit rather than baked into the data. See
[Grader & Judge](grader-and-judge.md).

## Versions

Datasets are registry documents: `(workspace, id, version)`, immutable versions, `latest` by semver,
`_shared` fallback for the bundled reference sets. A scorecard records the dataset version it
evaluated, so "the benchmark changed" and "the agent changed" never get mistaken for each other.

Adding cases means a new version. Editing a case in place would rewrite history for every scorecard
that ever ran it, which is why you cannot.

## Bringing an existing benchmark

You do not have to author cases by hand. A benchmark recipe maps an existing format — jsonl, a repo of
task directories — onto cases, keeping their identities:

```bash
cat examples/bundles/codex-pinch/bundle.json   # harness + dataset + recipe, as data
curl -XPOST localhost:8787/bundles/apply \
  -H 'content-type: application/json' -d @examples/bundles/codex-pinch/bundle.json
```

Reference bundles live in `examples/datasets/` and `examples/bundles/`. See
[`../../architecture/standard-task-formats.md`](../../architecture/standard-task-formats.md).

## Designing cases that mean something

A few things that are learned expensively:

- **A case must be able to fail.** If every agent passes it, it is measuring nothing. Keep it and add
  a harder one, or drop it.
- **Prefer deterministic grading.** A judge adds its own variance to every number it produces. Use one
  when the output has no checkable shape, not by default.
- **Match the environment to the task.** A `prompt` case that should have been a `repo` case will pass
  agents that cannot actually write working code. See [Environments](../workspace/environments.md).
- **Size the timeout to the task, not the agent.** A timeout that a good agent hits is a grader for
  speed, whether you meant it that way or not.

## See also

- [Environments](../workspace/environments.md) — what `env` can be
- [Scorecard](scorecard.md) — what happens when a dataset meets a harness
- [`../../datasets.md`](../../datasets.md) — import, provenance, recipes
