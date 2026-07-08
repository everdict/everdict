# Everdict MCP tool catalog

All tools run over the same service core as the HTTP API, are **role-gated** (`viewer < member <
admin`) and **workspace-scoped**. Authorization/validation failures come back as MCP tool errors
(`isError`), e.g. `FORBIDDEN: …`, `CONFLICT: …`, `NOT_FOUND: …`. Tool names below are the raw
Everdict tool ids; in Claude Code they surface as `mcp__everdict__<tool>`.

## Runs (the primitive)

| Tool | Role | Effect |
|---|---|---|
| `list_runs` | viewer | the caller's workspace runs. `scorecard_id` filter → a batch's child runs. |
| `get_run` | viewer | one run (other workspace → `NOT_FOUND`). |
| `submit_run` | member | submit a single eval run (repo empty seed + default graders). |

## Harnesses (the agent under test)

| Tool | Role | Effect |
|---|---|---|
| `list_harnesses` | viewer | workspace + `_shared` instances, grouped by template id. |
| `get_harness_instance` | viewer | one raw `HarnessInstanceSpec` (template ref + pins; `version` or `latest`). |
| `register_harness` | viewer | register a `HarnessInstanceSpec` (resolve-validated, immutable → `CONFLICT`). |
| `list_harness_templates` | viewer | workspace + `_shared` templates (structure/slots). |
| `get_harness_template` | viewer | one `HarnessTemplateSpec`. |
| `register_harness_template` | viewer | register a `HarnessTemplateSpec` (immutable → `CONFLICT`). |

For a plain CLI agent, register an **instance** with a `command` spec (see workflows). Templates are
for parameterized / service-topology harnesses.

## Datasets (eval cases)

| Tool | Role | Effect |
|---|---|---|
| `list_datasets` | viewer | workspace + `_shared` benchmark datasets. |
| `get_dataset` | viewer | one dataset incl. cases (`version` opt, default `latest`). |
| `diff_datasets` | viewer | version diff (`id`, `base`, `candidate`): added/removed/changed cases. |
| `validate_dataset` | member | dry-run: schema + conflict check (no write). |
| `create_dataset` | member | register a `Dataset` (immutable → `CONFLICT`); stamps `createdBy`. |
| `delete_dataset` | creator/admin | soft-delete one version (tombstone; exact `version` required). |

## Judges & models (verdicts)

| Tool | Role | Effect |
|---|---|---|
| `list_judges` | viewer | workspace + `_shared` Agent Judges (`model` \| `harness`). |
| `get_judge` | viewer | one `JudgeSpec`. |
| `validate_judge` | member | dry-run. |
| `create_judge` | member | register a `JudgeSpec` (immutable → `CONFLICT`). |
| `list_models` | viewer | workspace + `_shared` Models (provider + sub-model + baseUrl). |
| `get_model` | viewer | one `ModelSpec`. |
| `validate_model` | member | dry-run. |
| `create_model` | member | register a `ModelSpec`; referenced by id from judges / command harnesses. |

## Runtimes (where it runs)

| Tool | Role | Effect |
|---|---|---|
| `list_runtimes` | viewer | workspace + `_shared` runtimes (`local` \| `nomad` \| `k8s`). |
| `get_runtime` | viewer | one `RuntimeSpec`. |
| `validate_runtime` | viewer | dry-run. |
| `probe_runtime` | viewer | live connection test: build the backend + `probe()` → `{kind, reachable, detail}`. |
| `create_runtime` | viewer | register a `RuntimeSpec` (immutable → `CONFLICT`). |

## Scorecards (the payoff)

| Tool | Role | Effect |
|---|---|---|
| `run_scorecard` | member | batch-eval a dataset × `harness@version` → queued `ScorecardRecord` (poll `get_scorecard`). |
| `list_scorecards` | viewer | the workspace's scorecards (summary only). |
| `get_scorecard` | viewer | one scorecard incl. per-case results + `summary`. |
| `diff_scorecards` | viewer | compare two scorecards → metric Δ + regressions/improvements. |
| `ingest_scorecard` | member | upload externally-run `TraceEvent[]` → scorecard (no harness run; **push**). |
| `pull_scorecard` | member | pull traces from OTel/MLflow/Langfuse/LangSmith/Phoenix (`source` + `runs:[{caseId,runId}]`, `authSecret`) → scorecard (**pull**). |

## Example arguments

`run_scorecard`:
```jsonc
{
  "dataset": "my-bench",            // id (uses latest) or "id@version"
  "harness": "my-agent@1.0.0",
  "runtime": "local",              // a registered runtime id
  "cases": { "tags": ["smoke"], "limit": 5 },   // optional subset for a cheap run
  "concurrency": 4
}
```

`register_harness` (a command harness instance):
```jsonc
{
  "kind": "command",
  "id": "my-agent", "version": "1.0.0",
  "command": "my-agent --message {{task}} --model {{model}} .",
  "model": "sonnet",
  "trace": { "kind": "none" }
}
```

`get_scorecard` → returns `{ status, summary: { <metric>: { passRate|mean } }, scorecard: { cases: [...] } }`.
Poll until `status` ∈ terminal states.

Rule of thumb: **`list_*` before `create_*`** (entities are immutable — reuse `_shared` or bump the
version), and **submit → poll** for anything that runs (runs and scorecards are async).
