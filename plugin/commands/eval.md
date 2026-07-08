---
description: Guided evaluation of the current project's agent with Everdict — inspect the agent, propose a harness + dataset, run a scorecard, report the verdict.
argument-hint: "[what to evaluate / benchmark id]"
---

Drive an end-to-end Everdict evaluation of the agent in the **current working directory**. Focus /
benchmark hint (if any): `$ARGUMENTS`.

First confirm the `everdict` MCP tools are connected (run `/everdict:setup` if not). Then:

## 1. Understand the agent under test

Inspect this repo to figure out how the agent is invoked as a CLI: look for the entrypoint, README
usage, `package.json`/`pyproject.toml` scripts, and any `--message`/`--task`/prompt flag. Determine
the single shell command that runs it on one task. Ask the user to confirm the invocation and which
`model` to use. This becomes a **`command` harness**:

```jsonc
register_harness {
  "kind": "command", "id": "<repo-agent>", "version": "1.0.0",
  "command": "<the CLI> --message {{task}} --model {{model}} .",
  "model": "<sonnet|…>",
  "trace": { "kind": "none" }
}
```

## 2. Choose the dataset

Call `list_datasets` and prefer a `_shared` benchmark that matches `$ARGUMENTS`. If none fits,
propose a **small** dataset (3–8 cases) grounded in what this agent is supposed to do, and
`create_dataset` it after the user confirms. Each case needs a `task` and a grader (`tests-pass`
with a check command for code tasks; a `model` judge for free-form answers).

## 3. Run + report

1. `run_scorecard { dataset, harness: "<id>@1.0.0", runtime: "<a runtime from list_runtimes>",
   cases: { limit: 3 } }` — start with a cheap smoke subset.
2. Poll `get_scorecard` until terminal.
3. Report the `summary` (passRate/mean) and call out any failed cases with their `detail`. If the
   smoke run looks right, offer to run the full dataset and, on a later version, `diff_scorecards`
   for regression.

Throughout, follow the `everdict` skill's guardrails: `list_*` before `create_*` (entities are
immutable — bump the version to change one), reuse `_shared` where possible, and always submit →
poll. Read `references/workflows.md` for the exact call shapes.
