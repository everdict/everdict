# Execution · Orchestration · Scoring — the three concerns

> **Status: SHIPPED (S1 `ad7cdc2` + S2 `91f7c55`).** Doc-first SSOT for a **fundamental** separation of concerns in
> the control plane. Successor to [run-as-primitive](./run-as-primitive.md): that made `run` the execution primitive
> and `scorecard = run × N`; this untangles the three concerns that were smeared across two services (`RunService`,
> `ScorecardService`). Goal is architectural cleanliness — concern isolation + a clean collaboration model.
>
> **The three concerns are now separated:**
> - **Execution** = `execute-case.ts` `executeCase(deps, owner, job) → CaseResult` — pure: repo-token + dispatch
>   (+ completing a job-deferred trace collection, `traceRef` — see
>   [streaming-case-pipeline](./streaming-case-pipeline.md) D4).
>   No settle/offload/notify (S2 stripped `settle` out). `run` no longer cares about "after".
> - **Scoring** = `scoring-service.ts` `ScoringService` — judge application over results, independent of how
>   they were produced (S1). Live batch **and** ingest share it. Aggregation stays pure in `@assay/suite`.
> - **Orchestration** = `RunService` (single: admit → executeCase → settle → offload → webhook → notify) and
>   `ScorecardService` (batch: fan-out executeCase + per-case settle/child-run → `ScoringService` → suite aggregate
>   → store). These *drive* execution and *own* delivery/accounting.
>
> **Deliberately NOT done** (evaluated, deemed unnecessary — separation is already achieved, these would be DRY
> gold-plating): `materializeRun` (the RunRecord create/update lives in each orchestrator managing *its own* record
> lifecycle — not duplication of a concern); a separate `BatchDriver` class (`ScorecardService.track` already *is*
> the batch orchestrator, now delegating execution→`executeCase` and scoring→`ScoringService`).

## Problem — 3 concerns tangled into 2 services (feels "artificial")

There are three genuinely distinct concerns:

| Concern | Essence | Owner |
|---|---|---|
| **Execution** | run one case → a result (trace/snapshot). Nothing after. | `run` |
| **Orchestration** | decide what to run · fan-out · collect · admit/settle · deliver (202/poll/webhook) · notify · progress | the orchestrator |
| **Scoring** | over results/traces: grade · judge · aggregate (summary) · compare (diff) · rank (leaderboard) | the evaluator |

Today they are collapsed into **two** services, both of which *drive execution* — which is exactly why "there are
two objects for the same execution" feels wrong:

- **`RunService` is not pure execution.** `track()` does, after dispatch: `budget.settle` → `offloadSnapshot` →
  `store.update` → `onComplete` (Mattermost) → `fireWebhook`. A "run" should not care about the *after* — settle,
  offload, notify, webhook are delivery/accounting = orchestration. Even `executeCase` does `budget.settle`.
- **`ScorecardService` does all three at once.** `track()` interleaves execution driving (`runSuite`), **scoring**
  (`applyJudges`), aggregation (`summarizeScorecard` / `scorecardModels`), progress steps,
  persistence, and notify — one ~600-line service.
- Consequence: **scoring can't be used without the batch execution path**, and execution can't be driven without an
  orchestrator dragging delivery concerns. Separable things are forced to cohabit → the "artificial" feeling.

### The proof that scoring is separable: ingest

`POST /scorecards/ingest{,/pull}` produces a full scorecard **without executing anything** — it takes external
traces and runs `applyJudges` / `summarize`. So **scoring is already an independent function over
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
     · repoToken · dispatch         admit → materializeRun            results, {judges}, ctx)
     · (NO settle/notify)           → settle → offload                 · applyJudges (JudgeRunner)
                                    → webhook → notify (202)
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

| Module | Concern | Responsibility (as shipped) |
|---|---|---|
| `execute-case.ts` | Execution | `executeCase(deps, owner, job) → CaseResult` — repo-token resolve+attach + dispatch **only**. No settle/offload/notify. |
| `scoring-service.ts` | Scoring | `ScoringService` — `applyJudges` + `collectJudgeModels` over results. Used by batch **and** ingest. Aggregation stays pure in `@assay/suite`. |
| `run-service.ts` | Orchestration (single) | admit → create → `executeCase` (async) → **settle** → offload → webhook → notify. 202. |
| `scorecard-service.ts` | Orchestration (batch) + composition | `submit` = fan-out `executeCase` per case (+ per-case settle + child-run lifecycle) → `ScoringService` (judges) → `@assay/suite` (summarize/models) → store. `ingest` = fetch traces → `ScoringService` → store. Now clearly *scoring/aggregation-focused*, delegating execution + scoring out. |
| `notification-service.ts` | Orchestration (delivery) | already separate; a completion hook (run + scorecard). |

> No `materialize-run.ts` / `batch-driver.ts` were created — see the status block. The RunRecord create/update in
> each orchestrator is that orchestrator managing its own record lifecycle, and `ScorecardService.track` already
> *is* the batch orchestrator. Extracting them would be DRY gold-plating, not concern separation.

## What moves where

- **out of `executeCase`**: `budget.settle` → into orchestration (RunService / BatchDriver settle after reading the
  result's cost). `executeCase` becomes pure "get a `CaseResult` for a job".
- **out of `RunService.track`**: nothing leaves the service, but it is re-expressed as `admit → materializeRun →
  settle → offload → webhook → notify` so the *execution* part is the shared `materializeRun` and the rest is
  visibly orchestration.
- **out of `ScorecardService`**: `applyJudges` → `ScoringService`. `ScorecardService.track` keeps
  only: fan-out (via BatchDriver/`materializeRun`), progress steps, calling the scorer, aggregating (suite), storing.
- **unchanged**: `@assay/graders`, `@assay/suite` (already pure), `@assay/runner` (in-sandbox), API response shapes,
  `runIds`/child-run behavior, ingest's embed-only, MCP/HTTP surface.

## Migration slices

- **S1 — extract `ScoringService`** ✅ `ad7cdc2`. `applyJudges`/`collectJudgeModels` → `ScoringService`;
  `ScorecardService` builds one from its deps and delegates; live batch + ingest share it. 146 existing + 4 new tests.
- **S2 — `run` = pure execution** ✅ `91f7c55`. Stripped `settle` (+ `costOf`/`budget`/`tenant`) from `executeCase`;
  `RunService.track` and the scorecard batch closure settle after execution. 310 api tests green.
- **S3 — docs + skill** ✅ (this change). `materializeRun`/`BatchDriver` evaluated and deferred as DRY gold-plating
  (see status block) — the three concerns are already separated by S1+S2.

## Invariants / non-goals

- **Do NOT route the batch through `RunService.submit`.** That bundles single-run *delivery* (202/webhook/per-run
  notify/submit-admit) which must not fire per case. The shared unit is `executeCase` (pure execution), not the
  single-run orchestrator. (See [run-as-primitive](./run-as-primitive.md) §"왜 RunService 를 안 거치나".)
- **In-sandbox `@assay/runner` untouched.** This is a control-plane decomposition only.
- **No API/MCP/web shape changes.** `GET /scorecards/:id` still returns a hydrated scorecard; `POST /runs` etc.
  unchanged. This is an internal seam refactor.
- **Ingest stays embed-only** (no dispatched runs) — it scores fetched traces via the same `ScoringService`.

## Skills/docs updated

- `.claude/skills/api-layer` — the execution/orchestration/scoring seam (`executeCase` pure · `ScoringService` ·
  services orchestrate).
- `docs/api.md` / `docs/scorecards.md` — surface unchanged (internal seam refactor); no client-visible change.

## Verification (CLOSED)

- **api 310 unit/integration tests green** (in-memory + fake `SqlClient`). `ScoringService` has its own 4 unit
  tests; `executeCase` reduced to pure-execution tests; self-hosted settle-skip guarded at the service level.
- **Live-verified against real Postgres 16 (docker):** migrations apply cleanly and the child-run store path
  (`PgRunStore` filter, `PgScorecardStore.runIds` jsonb) round-trips on real PG.
- **web `next build` green.** Legacy swept: stale post-S2 comment fixed, `resolveRepoToken` made module-internal.
- **Nothing open.** `materializeRun`/`BatchDriver` are documented non-goals (DRY gold-plating), not TODOs.
