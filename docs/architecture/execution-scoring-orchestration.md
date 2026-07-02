# Execution · Orchestration · Scoring — the three concerns

> **Status: DESIGN (implementation in slices).** Doc-first SSOT for a **fundamental** separation of concerns in the
> control plane. Successor to [run-as-primitive](./run-as-primitive.md): that made `run` the execution primitive and
> `scorecard = run × N`; this goes further and untangles the three concerns that are currently smeared across two
> services (`RunService`, `ScorecardService`). Goal is architectural cleanliness — concern isolation + a clean
> collaboration model — not incremental ROI.

## Problem — 3 concerns tangled into 2 services (feels "artificial")

There are three genuinely distinct concerns:

| Concern | Essence | Owner |
|---|---|---|
| **Execution** | run one case → a result (trace/snapshot). Nothing after. | `run` |
| **Orchestration** | decide what to run · fan-out · collect · admit/settle · deliver (202/poll/webhook) · notify · progress | the orchestrator |
| **Scoring** | over results/traces: grade · judge · metric · aggregate (summary) · compare (diff) · rank (leaderboard) | the evaluator |

Today they are collapsed into **two** services, both of which *drive execution* — which is exactly why "there are
two objects for the same execution" feels wrong:

- **`RunService` is not pure execution.** `track()` does, after dispatch: `budget.settle` → `offloadSnapshot` →
  `store.update` → `onComplete` (Mattermost) → `fireWebhook`. A "run" should not care about the *after* — settle,
  offload, notify, webhook are delivery/accounting = orchestration. Even `executeCase` does `budget.settle`.
- **`ScorecardService` does all three at once.** `track()` interleaves execution driving (`runSuite`), **scoring**
  (`applyJudges` / `applyMetrics`), aggregation (`summarizeScorecard` / `scorecardModels`), progress steps,
  persistence, and notify — one ~600-line service.
- Consequence: **scoring can't be used without the batch execution path**, and execution can't be driven without an
  orchestrator dragging delivery concerns. Separable things are forced to cohabit → the "artificial" feeling.

### The proof that scoring is separable: ingest

`POST /scorecards/ingest{,/pull}` produces a full scorecard **without executing anything** — it takes external
traces and runs `applyJudges` / `applyMetrics` / `summarize`. So **scoring is already an independent function over
traces**; it only *looks* coupled because it lives as methods on `ScorecardService` next to the execution path.
Ingest is the existence proof for Concern 3.

## Two execution *layers* (don't confuse them)

- **In-sandbox** (`@assay/runner` `runCase`): drive the harness-under-test via a Driver → `CaseResult`, *inside* the
  isolated agent job. Untouched by this refactor.
- **Control plane** (this doc): dispatch a job to a backend, get the `CaseResult` back, record it. This is where the
  three concerns tangle. To avoid a name clash with `runner.runCase`, the control-plane unit is **`materializeRun`**.

## Principles

1. **`run` = pure execution.** Dispatch a case → `CaseResult` → a `RunRecord`. It does not settle budget, offload,
   notify, webhook, judge, or aggregate. It knows nothing about "after".
2. **Scoring is a pure-ish function over results** (given a `JudgeRunner`), independent of *how* the results were
   produced. One scorer serves live batches **and** ingest.
3. **The orchestrator drives.** Admission, concurrency, fan-out, budget settle, delivery (202/webhook), notify,
   progress — all live here, wrapping pure execution and pure scoring.
4. **`scorecard` is a scoring artifact over a set of runs**, not a second execution object.

## Target model

```
   Execution (run)                Orchestration                     Scoring (evaluator)
   ───────────────                ─────────────                     ───────────────────
   executeCase(job) → CaseResult  RunService (single):              ScoringService.score(
     · repoToken · dispatch         admit → materializeRun            results, {judges,metrics}, ctx)
     · (NO settle/notify)           → settle → offload                 · applyJudges (JudgeRunner)
                                    → webhook → notify (202)            · applyMetrics (MetricRegistry)
   materializeRun(record, job)                                         → scored results
     = executeCase + record       BatchDriver (scorecard):          @assay/suite (pure):
       (create→exec→update)         admit/settle per case              summarize · diff · leaderboard
       returns RunRecord            → fan-out materializeRun          @assay/graders (pure): grade
       "뒤는 신경 안 씀"             → collect → steps
                                    → hand results to ScoringService
        ▲                                   │        ▲                        ▲
        └──────── orchestrator drives runs ─┘        └── results → scorer ────┘

   scorecard = ScoringService(scored) over the runs a BatchDriver produced   (ingest = scorer over fetched traces)
```

### Module layout (`apps/api/src`)

| Module | Concern | Responsibility |
|---|---|---|
| `execute-case.ts` | Execution | `executeCase(job) → CaseResult` — repo-token + dispatch **only** (settle removed). |
| `materialize-run.ts` *(new)* | Execution | `materializeRun({record, job}, deps) → RunRecord` — executeCase + create/update the RunRecord. Both single + batch call it. |
| `scoring-service.ts` *(new)* | Scoring | `ScoringService.score(tenant, dataset, results, {judges, metrics, runtime})` — applyJudges + applyMetrics (moved out of ScorecardService). Used by batch **and** ingest. Aggregation stays in `@assay/suite`. |
| `run-service.ts` | Orchestration (single) | admit → create → `materializeRun` (async) → settle → offload → webhook → notify. 202. |
| `batch-driver.ts` *(new, or a slim ScorecardService.track)* | Orchestration (batch) | fan-out `materializeRun` per case, admit/settle per case, progress steps, collect results. |
| `scorecard-service.ts` | Composition | `submit` = BatchDriver.run(dataset, harness, runtime) → results → `ScoringService.score` → suite.summarize/models → store. `ingest` = fetch traces → `ScoringService.score` → store. Now clearly *scoring-focused*. |
| `notification-service.ts` | Orchestration (delivery) | already separate; stays a completion hook (run + scorecard). |

## What moves where

- **out of `executeCase`**: `budget.settle` → into orchestration (RunService / BatchDriver settle after reading the
  result's cost). `executeCase` becomes pure "get a `CaseResult` for a job".
- **out of `RunService.track`**: nothing leaves the service, but it is re-expressed as `admit → materializeRun →
  settle → offload → webhook → notify` so the *execution* part is the shared `materializeRun` and the rest is
  visibly orchestration.
- **out of `ScorecardService`**: `applyJudges` + `applyMetrics` → `ScoringService`. `ScorecardService.track` keeps
  only: fan-out (via BatchDriver/`materializeRun`), progress steps, calling the scorer, aggregating (suite), storing.
- **unchanged**: `@assay/graders`, `@assay/suite` (already pure), `@assay/runner` (in-sandbox), API response shapes,
  `runIds`/child-run behavior, ingest's embed-only, MCP/HTTP surface.

## Migration slices (each shippable + green; pathspec commits — shared tree is hot)

- **S1 — extract `ScoringService`** *(highest value: the "execution vs scoring" split the user asked for)*.
  Move `applyJudges`/`applyMetrics` into `ScoringService`; `ScorecardService.track` and `finishIngest` both call it.
  Additive move — existing scorecard + ingest tests are the regression guard.
- **S2 — `run` = pure execution.** Strip `settle` from `executeCase`; add `materializeRun`; `RunService` settles in
  the orchestration wrapper; batch fan-out uses `materializeRun`. Existing run/scorecard tests guard behavior.
- **S3 — thin orchestration + `scorecard` composes.** `ScorecardService.submit` reads as
  `drive batch → score → aggregate → store`. Optional `BatchDriver` extraction if it clarifies. Docs + skill refs.

## Invariants / non-goals

- **Do NOT route the batch through `RunService.submit`.** That bundles single-run *delivery* (202/webhook/per-run
  notify/submit-admit) which must not fire per case. The shared unit is `materializeRun` (execution), not the
  single-run orchestrator. (See [run-as-primitive](./run-as-primitive.md) §"왜 RunService 를 안 거치나".)
- **In-sandbox `@assay/runner` untouched.** This is a control-plane decomposition only.
- **No API/MCP/web shape changes.** `GET /scorecards/:id` still returns a hydrated scorecard; `POST /runs` etc.
  unchanged. This is an internal seam refactor.
- **Ingest stays embed-only** (no dispatched runs) — it scores fetched traces via the same `ScoringService`.

## Skills/docs to update (in the slice that changes the invariant)

- `.claude/skills/api-layer` — the execution/orchestration/scoring seam; `ScoringService` + `materializeRun`.
- `docs/scorecards.md` — scorecard = scored view over runs (scoring extracted).
- `docs/api.md` — unchanged surface (note internal seam only if relevant).
