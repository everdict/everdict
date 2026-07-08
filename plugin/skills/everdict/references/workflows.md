# Everdict workflows (recipes)

Each recipe is a sequence of MCP tool calls. Runs and scorecards are **async** — submit, then poll.

## 1. Evaluate your own CLI agent (the fast path)

**Goal:** score a CLI agent (yours, aider, codex, …) on a benchmark.

1. **Find a dataset.** `list_datasets` → reuse a `_shared` benchmark if one fits; else create one:
   ```jsonc
   create_dataset {
     "id": "my-bench", "version": "1.0.0",
     "cases": [
       { "id": "c1", "task": "Create ok.txt with the text done",
         "graders": [{ "id": "tests-pass", "config": { "test": "grep -q done ok.txt" } }] }
     ]
   }
   ```
2. **Register your agent** as a `command` harness instance:
   ```jsonc
   register_harness {
     "kind": "command", "id": "my-agent", "version": "1.0.0",
     "command": "my-agent --message {{task}} --model {{model}} .",
     "model": "sonnet",
     "trace": { "kind": "none" }        // stdout → final assistant message; outcome graders still work
   }
   ```
   `{{task}}` is shell-quoted automatically — don't wrap it in quotes. LLM keys come from the
   workspace's per-tenant secrets, not `env`.
3. **Run the scorecard:**
   ```jsonc
   run_scorecard { "dataset": "my-bench", "harness": "my-agent@1.0.0", "runtime": "local" }
   ```
   → a `queued` record with an id.
4. **Poll and read:** `get_scorecard { id }` until `status` is terminal → `summary` (passRate/mean)
   + per-case results. A failed case carries `trace:[{kind:"error", message}]` and its reason in the
   score `detail`.

Cheap smoke first: add `"cases": { "limit": 3 }` to step 3.

## 2. Regression: did the new version get worse?

1. Register the new harness version (e.g. `my-agent@1.1.0`).
2. `run_scorecard` for it on the **same dataset**.
3. `diff_scorecards { base: <old scorecard id>, candidate: <new scorecard id> }` → per-metric Δ +
   which cases **regressed** vs **improved**. This is the version-gate signal.

## 3. Grade with an LLM/agent judge (correctness beyond tests-pass)

When the answer is free-form (a printed answer, a screenshot, a trajectory), add an **Agent Judge**:

1. `list_judges` → reuse `_shared`, or `create_judge`:
   ```jsonc
   create_judge {
     "id": "answer-correct", "version": "1.0.0", "kind": "model",
     "model": "claude-sonnet-...",              // a model id (list_models)
     "prompt": "Given the task and the agent's final answer, score correctness 0..1 …"
   }
   ```
2. Reference the judge when you `run_scorecard` (judges apply per-trace) → each case also gets a
   `judge:answer-correct` score in the summary.

Model judges call the provider with **your workspace's** SecretStore key — register the key in
workspace settings first.

## 4. Score traces you already have (no harness run)

You ran your agent elsewhere and captured traces — skip execution, just score.

- **Push:** `ingest_scorecard { dataset, runs: [{ caseId, trace: TraceEvent[] }] }` → scorecard.
- **Pull:** `pull_scorecard { dataset, source: { kind: "mlflow"|"otel"|"langfuse"|"langsmith"|"phoenix", endpoint, authSecret? }, runs: [{ caseId, runId }] }`
  → Everdict pulls each trace by id and scores it. `authSecret` names a SecretStore key used
  verbatim as the pull's `Authorization` header.

Same graders/judges as a live run — the only difference is where the trace came from.

## 5. Rank harness × model (leaderboard)

Once you have scorecards across harness versions / models, the leaderboard ranks them per benchmark
(models are captured both observed-from-trace and declared-in-spec). Use `list_scorecards` +
`diff_scorecards` for the pairwise view; the web dashboard renders the full leaderboard with drift
badges.

## 6. Bigger runs

- **Subset / smoke:** `run_scorecard` `cases` = `{ ids: [...] }` | `{ tags: [...] }` | `{ limit: N }`.
- **Parallelism:** `concurrency` (1–64, default 4). For a self-hosted runtime the effective
  parallelism is `min(concurrency, runner workers)` — start more runner workers to go faster.
- **Your own machine:** register a self-hosted runner and target `runtime: "self:<id>"` — jobs park
  in a lease queue your runner drains locally (own-login pays; workspace budget untouched).

## Guardrails

- **`list_*` before `create_*`/`register_*`** — entities are immutable; to change one, bump the
  `version`. A duplicate version is a `CONFLICT`, not an overwrite.
- **Prefer `_shared`** benchmarks/judges/models over re-creating your own.
- **Submit → poll.** Never assume a run finished synchronously.
- **Errors are typed.** `FORBIDDEN` = your role lacks the action; `NOT_FOUND` = wrong workspace or
  id; `CONFLICT` = that version already exists.
