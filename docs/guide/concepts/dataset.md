# Dataset

A **dataset is a bundle of eval cases** — the fixed set of problems you measure an agent against.

Its defining property is what it does *not* contain: **a dataset is harness-agnostic.** A case
describes the task and the world it happens in, never the agent that will attempt it. That is what lets
you run the same dataset against Claude Code, a Codex harness, and your own CLI agent, and compare the
three honestly.

## What a case carries

An `EvalCase` is the unit:

| Field | What it is |
| --- | --- |
| `id` | stable identity — this is what a diff matches on across scorecards |
| `env` | the world: a repo (files + git), a browser, an OS session |
| `task` | the instruction handed to the agent |
| `expected` | optional expected result, for graders that need ground truth |
| `milestones` | intermediate checkpoints, for partial credit |
| `graders` | how this case is scored (`GraderSpec[]`) |
| `image` | the environment image the case runs in, when it needs a specific one |
| `fixtures` | files or data seeded before the agent starts |
| `timeoutSec` | the wall-clock ceiling |
| `tags` | labels — also the selector for running a subset |
| `placement` | a hint about where this case needs to run (e.g. an OS target) |

`id` deserves emphasis. Case ids are how `GET /scorecards/diff` decides that this run's `write-file` is
the same problem as last run's `write-file`. Renaming a case silently breaks the trend for that case.

## Versioning

Datasets are registry documents: `(workspace, id, version)`, immutable versions, `latest` by semver,
`_shared` fallback for the bundled reference sets. A scorecard records the dataset version it
evaluated, so "the benchmark changed" and "the agent changed" never get confused with each other.

## Bringing an existing benchmark

You do not have to author cases by hand. Everdict has an on-ramp for standard agent-benchmark formats —
import the tasks, keep their identities, run them managed. See
[`../../architecture/standard-task-formats.md`](../../architecture/standard-task-formats.md).

Reference bundles ship in `examples/datasets/`.

## Graders belong to the case — usually

A case names its graders, so the dataset defines what "solved" means for each problem. Two escape
hatches exist:

- A **submit-time `graders[]` override** replaces them for one batch — useful when you want to score an
  existing dataset a different way without forking it.
- **Judges** are applied on top, per trace, and are chosen at submit rather than baked into the
  dataset. See [Grader & Judge](grader-and-judge.md).

## Running only part of it

A scorecard submit can take a `subset`: explicit `ids`, matching `tags`, or a `limit`. The scorecard
records that it was a subset run, which matters — a pass rate over 10 of 400 cases is not the same
claim as a pass rate over 400.

## Where this shows up next

- [`../../datasets.md`](../../datasets.md) — the full reference: import, provenance, recipes
- [`../../registry.md`](../../registry.md) — versioning and `_shared` resolution
- [Scorecard](scorecard.md) — what happens when a dataset meets a harness
