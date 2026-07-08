---
name: everdict
description: >-
  Use when the user wants to evaluate, benchmark, score, or regression-test an AI
  agent / LLM harness with Everdict — or mentions Everdict, an Everdict scorecard,
  harness, dataset, judge, grader, runtime, or the Everdict MCP tools. Gives the
  Everdict domain model (harness · dataset · grader · judge · scorecard · runtime ·
  run), the evaluation workflow, and how to drive it through the Everdict MCP tools
  (`list_datasets`, `register_harness`, `run_scorecard`, `get_scorecard`, …).
---

# Everdict — evaluate any agent harness, get a defensible verdict

Everdict (**eval + verdict**) is a harness-agnostic, infra-agnostic runtime that **runs** an
agent harness (Claude Code, Codex, any CLI, or a multi-service topology) and **scores** it —
repeatably, with regression tracking and leaderboards. You talk to it through the **Everdict MCP
server** (bundled by this plugin as the `everdict` MCP server). Humans use the web dashboard;
agents and CI (you) use these MCP tools.

Your job when this skill is active: help the user **evaluate their agent** by driving the Everdict
MCP tools end-to-end. If the MCP tools are not connected yet, point them at `/everdict:setup`.

## The one-sentence mental model

> A **scorecard** runs a **dataset** (N eval cases) against one **harness@version** on a
> **runtime**, producing a normalized **trace** per case, which **graders** and **agent judges**
> turn into scores — aggregated into a pass-rate/mean **summary** you can diff across versions.

```
Dataset ──▶ [scorecard run on a runtime] ──▶ trace ──▶ graders + judges ──▶ Scorecard (+summary)
   │                    │                                                        │
 eval cases        harness@version                                    diff / leaderboard / dashboard
```

## The domain entities (all versioned, immutable, workspace-scoped)

Every entity is keyed `(workspace, id, version)` — versions are **immutable** (re-registering an
existing version is a `CONFLICT`), `latest` resolves the newest semver, and your workspace sees its
own entities **plus** shared `_shared` ones. `workspace = tenant = trust-zone`.

| Entity | What it is | Key MCP tools |
|---|---|---|
| **Harness** | the agent under test. Two kinds: a **`command`** harness (any CLI agent declared as data — no code) or a **service-topology** harness (multi-service). Registered as a template + pinned instance. | `list_harnesses`, `register_harness`, `get_harness_instance` |
| **Dataset** | harness-agnostic bundle of **eval cases** (task + grading spec). | `list_datasets`, `get_dataset`, `create_dataset`, `diff_datasets` |
| **Grader** | deterministic scoring signal on the trace/outcome: `tests-pass`, `cost`, `steps`, `latency`, `text-metric`, answer-match. (Built into the run — not separately registered.) | — |
| **Judge** | an **Agent Judge** — a `model` (LLM/VLM verdict) or `harness` (delegate an agent) judge applied per-trace on a scorecard. | `list_judges`, `create_judge` |
| **Model** | a provider + sub-model + baseUrl, referenced by id from judges / command harnesses. | `list_models`, `create_model` |
| **Runtime** | where a run executes: `local` \| `nomad` \| `k8s` (isolation = the orchestrator's), or the user's own machine via a self-hosted runner. | `list_runtimes`, `probe_runtime`, `create_runtime` |
| **Run** | the core primitive: one case executed once → trace + scores. A scorecard is a run × N. | `submit_run`, `list_runs`, `get_run` |
| **Scorecard** | batch eval: dataset × harness@version → aggregated `Scorecard` + `summary`. The payoff. | `run_scorecard`, `get_scorecard`, `list_scorecards`, `diff_scorecards` |

## The core workflow — evaluate the user's own agent

Most users arrive with **their own CLI agent** and want a score. The fast path uses a declarative
**`command` harness** (bring any CLI, no code) + a small **dataset** + a **scorecard**:

1. **Pick or create a dataset.** `list_datasets` first — a `_shared` benchmark may already fit.
   Else `create_dataset` with the eval cases (see `references/domain-model.md` for the case shape).
2. **Register the user's agent as a harness.** `register_harness` with a `command` spec — e.g.
   `command: "my-agent --message {{task}} --model {{model}} ."`. `{{task}}` is shell-quoted for you.
   (Full spec + template tokens: `references/workflows.md`.)
3. **(Optional) add a judge.** `create_judge` for an LLM/VLM/agent verdict when correctness isn't a
   simple `tests-pass` — e.g. grading a printed answer or a browser trajectory.
4. **Run the scorecard.** `run_scorecard` with `{dataset, harness@version, runtime}` → returns a
   **queued** `ScorecardRecord`. Poll `get_scorecard` until terminal.
5. **Read the verdict.** `get_scorecard` gives per-case results + a `summary` (passRate/mean). Use
   `diff_scorecards` to compare against a baseline (regression), or the leaderboard to rank
   harness×model.

Runs are **async**: submit → poll. Normal eval failures become failed cases (the batch still
succeeds); only infra/budget errors fail the whole run.

## Bring-your-own-trace (no harness run)

If the user already ran their agent elsewhere and has traces, skip execution and score the trace:
- `ingest_scorecard` — upload externally-run `TraceEvent[]` → scorecard (**push**).
- `pull_scorecard` — pull traces from their OTel / MLflow / Langfuse / LangSmith / Phoenix by
  `{caseId, runId}` → scorecard (**pull**).

## Connecting & auth

The `everdict` MCP server points at the user's Everdict control plane (`…/mcp`). Auth is
"login like Linear": on first use, an interactive client does a **browser OAuth login** (Keycloak);
headless agents/CI use an **API key** (`Authorization: Bearer ak_…`). If tools aren't showing up,
run **`/everdict:setup`**. Guided evaluation of the current project: **`/everdict:eval`**.

## References (read on demand)

- `references/domain-model.md` — every entity in depth: harness kinds (command vs service),
  the eval case shape, graders vs judges, trace kinds, versioning/`_shared`/tenancy, runtimes.
- `references/mcp-tools.md` — the full MCP tool catalog: signature, role, and example arguments.
- `references/workflows.md` — copy-pasteable recipes: command-harness eval, regression diff, adding
  a judge, scoring external traces, leaderboards.

Always call `list_*` before `create_*`/`register_*` — entities are immutable, so bump the `version`
to change one. Prefer a `_shared` benchmark over re-creating a dataset.
