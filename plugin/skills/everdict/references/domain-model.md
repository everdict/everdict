# Everdict domain model (in depth)

## The eval loop (what happens inside one run)

```
provision(runtime) → seed(environment) → install + run(harness) → normalized trace
                   → snapshot(environment) → grade(graders + judges) → CaseResult
```

A **run** executes one case once. A **scorecard** fans this loop out over N cases × one
harness@version and aggregates the `CaseResult`s into a `summary`.

## Harness — the agent under test

Two kinds:

### 1. `command` harness (bring any CLI agent, no code)

A CLI agent is declared as **data** — a single generic runner interprets it. This is the fast path
for evaluating your own agent.

```jsonc
{
  "kind": "command",
  "id": "my-agent", "version": "1.0.0",
  "image": "…",                         // optional dispatch image (default = the job-runner image)
  "setup": ["pip install --quiet my-agent==1.0.0"],   // run once in the sandbox before the task
  "command": "my-agent --message {{task}} --model {{model}} .",
  "model": "sonnet",
  "env": { },                            // extra env (LLM keys come from per-tenant secrets, not here)
  "trace": { "kind": "none" }            // see "Trace kinds" below
}
```

Template tokens in `command`: **`{{task}}`** (auto shell-quoted — do NOT wrap in quotes),
`{{model}}`, `{{run_id}}`. `setup`/`command` are arbitrary user code → they run only inside a trust
zone (gVisor/Kata + per-tenant namespace). Pin image/install versions.

Harnesses are stored as a **template** (structure/slots) + an **instance** (template ref + pins).
For a plain CLI you register an instance directly with `register_harness`.

### 2. service-topology harness (multi-service)

A deployed topology (agent / MCP / action-stream + Postgres/Redis/MinIO) that acts on a target env
(e.g. a browser + extension). Warm per-version services + shared ID-keyed stores + per-case target.
Register via `register_harness_template` + `register_harness`. Trace is pulled from OTel/MLflow.

## Dataset — harness-agnostic eval cases

A dataset is a versioned bundle of **cases**. A case is the task + how to grade it. Datasets are
**harness-agnostic** — the same dataset scores any harness. Shape (conceptually):

```jsonc
{
  "id": "my-bench", "version": "1.0.0",
  "cases": [
    {
      "id": "case-1",
      "task": "Create ok.txt containing the word done",   // the prompt/instruction
      "image": "…",                                        // optional: portability contract (Docker image seed)
      "graders": [ { "id": "tests-pass", "config": { "test": "grep -q done ok.txt" } } ],
      "tags": ["smoke"]
    }
  ]
}
```

- `create_dataset` registers a new version (immutable → `CONFLICT` if it exists).
- `validate_dataset` is a dry-run (schema + conflict check, no write).
- `diff_datasets` shows added/removed/changed cases between two versions.
- Import at scale: datasets can be recipe-imported (e.g. from a HuggingFace dataset) into cases.
- **Subset a run** without editing the dataset: `run_scorecard` accepts `cases` = `ids` (explicit)
  → `tags` (any-match) → `limit` (first N). Handy for a cheap smoke run.

## Grader vs Judge — two scoring families

- **Grader** (deterministic, built into the run): scores the outcome/trace with no model.
  - `tests-pass` — run a test command against the repo snapshot (pass/fail).
  - `cost`, `steps`, `latency` — numeric axes pulled from the trace.
  - `text-metric` — regex one capture group over the final assistant message → a numeric metric
    (e.g. `{pattern: "^steps: (\\d+)", metric: "agent_steps"}`), so even a `trace:none` CLI gets a
    step/score axis.
  - answer-match — compare the printed answer to an expected value.
- **Judge** (an **Agent Judge** — a model or agent renders the verdict), applied per-trace on a
  scorecard:
  - `model` judge — an LLM/VLM call scores the trace (uses your workspace's provider key). For
    correctness that isn't a simple test: grading a printed answer, a screenshot, a trajectory.
  - `harness` judge — delegate to an agent; the verdict comes from its trace.
  - Registered with `create_judge`; selected per scorecard. Each produces a `judge:<id>` score.

A model-backed grader **is** an agent judge — same idea, two entry points.

## Trace — the normalized record

Every harness run yields a normalized `TraceEvent[]` (messages, tool calls, cost, errors). This is
what graders/judges read. Trace kinds on a `command` harness:

- **`none`** — no trajectory/cost. The command's **stdout (tail 32k) becomes the final assistant
  message**, so prompt-QA benchmarks (answer-match / judge) grade a black-box CLI's printed answer;
  outcome grading (repo diff + `tests-pass`) still works. Non-zero exit → an `error` event.
- **`otel` / `mlflow` / `langfuse` / `langsmith` / `phoenix`** — an instrumented agent's trace is
  pulled after the command by `EVERDICT_RUN_ID` (injected). The agent tags its spans with that id
  (correlate `id` — runId is the trace id; or `tag` — the agent keeps its own ids and tags
  `everdict.run_id`). `collect: "job"` pulls in-sandbox after compute release; `"control-plane"`
  defers the pull. `authSecret` names a SecretStore key for the pull's `Authorization`.

Cost/tokens always come from the harness's own trace (e.g. Claude's `total_cost_usd`) — never
estimated.

## Runtime — where a run executes

A tenant-registered execution target: `local` (dev / control-plane host), `nomad`, or `k8s`
(isolation = the orchestrator's runtimeClass). "My own machine" = a **self-hosted runner** (the
push model flips to pull: jobs park in an owner-scoped lease queue; the runner leases → runs the
same eval loop locally → posts the result back with a provenance tag; own-login pays, so the
workspace budget isn't drawn). Tools: `list_runtimes`, `probe_runtime` (live reachability test, no
job), `create_runtime`.

## Scorecard — the aggregated verdict

`run_scorecard {dataset, harness@version, runtime, cases?, concurrency?}`:
1. Resolve dataset → cases (optional `cases` subset).
2. Resolve harness `latest → concrete` and embed its spec.
3. Fan out — each case becomes one job (a child run), concurrency-limited (`concurrency` 1–64,
   default 4).
4. Aggregate → `{status, summary, scorecard}`. `summary` = per-metric passRate/mean.

Poll `get_scorecard` until `status` is terminal. `diff_scorecards` compares two scorecards →
per-metric Δ + regressions/improvements. Partial runs are stamped `subset {total, selected}` so
consumers know it wasn't the full dataset.

## Versioning, `_shared`, and tenancy

- **Immutable versions.** Changing anything = a **new version**. `latest` = newest semver.
- **`_shared` fallback.** Reads see your workspace's entities first, then `_shared` (platform
  benchmarks/judges/models). Prefer reusing a `_shared` benchmark over re-creating one.
- **Workspace = tenant = trust-zone.** All tools are workspace-scoped; another workspace's entity
  reads as `NOT_FOUND`. Roles gate actions: `viewer` (read + register content) < `member` (submit
  runs, run scorecards, write datasets/judges) < `admin` (delete, manage members/keys).
