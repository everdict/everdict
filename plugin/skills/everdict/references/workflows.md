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

## 7. Bring your own eval environment image (build → push → register → pin)

**Goal:** the benchmark needs a stack no public image has. You build it; Everdict references it.

Everdict never builds or hosts images (**reference, not build**). The bytes go to the workspace's
own registry; the *meaning* goes to the store as an `environment` capability, so the next author
(human or agent) gets a pullable ref plus how to wire it — not a bare string.

0. **Check the store first.** `list_capabilities` / `list_public_capabilities` → entries whose
   `spec.type` is `environment`. If one fits, skip to step 4 and pin its `spec.image` verbatim.
1. **Build it locally.** Plain `docker build -t officeqa-env:v3 .` on a machine with Docker. Bake in
   what the task needs (fixtures, tooling, runtime deps).
   Targeting a MANAGED runtime (nomad/k8s), where the image IS the job and must boot the in-job
   agent itself? Wrap it first: `everdict image bake officeqa-env:v3 --tag officeqa-env:v3-ed`.
2. **Publish the bytes and register the asset in one step:**
   ```bash
   everdict image push officeqa-env:v3 \
     --register-environment officeqa-env \
     --env-description "LibreOffice + python3.12 fixtures for OfficeQA" \
     --benchmark officeqa \
     --instructions ./ENVIRONMENT.md \
     --api-url <control plane> --api-key ak_…
   ```
   It mints one-shot push credentials, `docker tag` + `docker push`es through a **temporary
   `DOCKER_CONFIG`** that is deleted afterwards (`~/.docker/config.json` is never read or written),
   reads `os`/`arch` off the local image, and registers the pushed ref as an environment —
   **digest-pinned** when Docker reports the pushed digest, so the pin is reproducible.
   Registration defaults to `workspace` reach (the team's, not just yours); `--visibility` overrides.

   Prerequisite: the workspace has a registry (`list_workspace_image_registries`). If none is
   registered, an admin adds one with `set_workspace_image_registry` (the token goes in the
   SecretStore first, referenced by name). With several, select one with `--registry <name>`.
3. **Or register separately** — when the image is already published, or you want to edit the asset:
   ```jsonc
   save_capability {
     "id": "officeqa-env", "name": "OfficeQA environment",
     "description": "LibreOffice + python3.12 fixtures for the OfficeQA benchmark",
     "visibility": "workspace",                      // the default for an environment — pass it only to narrow
     "spec": {
       "type": "environment",
       "image": "ghcr.io/acme/officeqa-env@sha256:…", // a mutable tag registers, but warns
       "contents": { "benchmark": "officeqa", "packages": ["libreoffice", "python3.12"], "os": "linux" },
       "preset": { "service": { "port": 8000 }, "dependencies": [] },   // optional wiring dowry
       "instructions": "Entry point · result path · seeded data · gotchas"
     }
   }
   ```
   `validate_capability` is the dry run (predicted version + image warnings, no write).
   `verify_image` answers "can this workspace actually pull it?" and hands back the digest to pin.
   `instructions` is the contract the next author reads — write it for someone who must wire this
   image without asking you.
4. **Pin the ref** wherever an image is named: a harness instance's `pins`, a service harness's
   `services[].image`, a `command` harness's `image`, or an eval case's `image`. Paste it
   **verbatim** and honor the `preset`/`instructions` instead of re-deriving the wiring.

Sharing beyond your workspace is `set_capability_visibility` (`workspace` → `subset` → `public`).
Sharing the **asset** does not share pull rights: the consuming workspace still needs its own
credential for that registry — name the registry in `instructions`.

## Guardrails

- **`list_*` before `create_*`/`register_*`** — entities are immutable; to change one, bump the
  `version`. A duplicate version is a `CONFLICT`, not an overwrite.
- **Prefer `_shared`** benchmarks/judges/models over re-creating your own.
- **Images are referenced, never built by Everdict.** Never pin a ref that exists only on the machine
  that built it — publish it (§7) first, or the run fails to pull on a managed runtime.
- **Submit → poll.** Never assume a run finished synchronously.
- **Errors are typed.** `FORBIDDEN` = your role lacks the action; `NOT_FOUND` = wrong workspace or
  id; `CONFLICT` = that version already exists.
