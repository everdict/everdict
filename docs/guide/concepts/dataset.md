---
kind: wiki
title: "Dataset"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/execution/eval-case.ts, packages/contracts/src/execution/dataset.ts, apps/api/src/api/scorecard/request/run-scorecard.ts, apps/api/src/api/dataset/dataset.routes.ts]
---
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

`id`, `env` and `task` are required; `graders` (default none), `timeoutSec` (default 1800) and `tags`
are the rest of the working set. The others earn their place when you need them:

- **`expected`** — the reference answer, for graders that compare against it and for judges as evidence.
- **`milestones`** — intermediate expectations a judge checks against the trace, so a failed run shows
  which step broke.
- **`image`** — the environment image, when the case needs a specific one.
- **`fixtures`** — seeds for a service harness's data stores (`postgres`, `redis`, `minio`), applied
  before the agent starts.
- **`placement`** — a hint about where the case must run (`target`, `os`, `isolation`).
- **`resources`** / **`network`** — the box (`cpu`, `memoryMb`, `gpu`) and network reach the task needs;
  a runtime that cannot provide them refuses the case.
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
  "runtime": "local",
  "cases":   { "tags": ["smoke"], "limit": 20 }
}'
```

`cases` applies `ids`, then `tags` (any match), then `limit` (first N). The scorecard records that it
was a subset run. That matters: a pass rate over 20 of 400 cases is not
the same claim as a pass rate over 400, and a chart that mixes the two is lying quietly.

## Graders on the case are a default

A case's `graders` are its default grading plan — what "solved" means for that problem when nobody says
otherwise. Two ways to score differently without editing the data:

**Replace for one batch** — a scorecard's `graders` replaces every case's plan for that batch:

```json
{ "dataset": { "id": "retrieval-smoke", "version": "latest" },
  "harness": { "id": "my-agent", "version": "latest" },
  "runtime": "local",
  "graders": [{ "id": "command", "config": { "cmd": "./stricter-check.sh" } }] }
```

**Judges** — applied on top, per trace, chosen at submit rather than baked into the data. See
[Grader & Judge](grader-and-judge.md).

## Versions

Datasets are registry documents: `(workspace, id, version)`, immutable versions, `latest` by semver. A
scorecard records the dataset version it evaluated, so "the benchmark changed" and "the agent changed"
never get mistaken for each other.

Adding cases means a new version. Editing a case in place would rewrite history for every scorecard
that ever ran it, which is why you cannot.

## Bringing an existing benchmark

You do not have to author cases by hand. A benchmark recipe maps an existing source — `jsonl`, a
`huggingface` dataset, a `terminal-bench` task set — onto cases, keeping their identities:

```bash
cat examples/bundles/codex-pinch/bundle.json   # harness + dataset + recipe, as data
curl -XPOST localhost:8787/bundles/apply \
  -H 'content-type: application/json' -d @examples/bundles/codex-pinch/bundle.json
```

Reference datasets and bundles live in `examples/datasets/` and `examples/bundles/`; nothing is
pre-registered, so apply the ones you want. See
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
