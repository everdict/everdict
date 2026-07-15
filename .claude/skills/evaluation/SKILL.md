---
name: evaluation
description: Everdict's scoring/eval domain — graders, judges, scorecards, regression/leaderboard, saved views — the eval-first product core. Use when editing scoring, graders, judges, scorecards, suites, or views.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Evaluation (the eval-first core)

Everdict *is* an eval runtime. One case: `runCase` → per-case `Score[]` from graders. A batch:
dataset×harness → `Scorecard` + summary via `runSuite`. Regression = `diffScorecards`; ranking =
`leaderboard`. Cost/tokens come from the **harness's own trace** (Claude `total_cost_usd`), never measured by us.

## Checklist
1. Score = `{graderId, metric, value, pass?, detail?}` (`@everdict/contracts`). A grader reads trace + snapshot, never mutates.
2. Batch always through `runSuite` (`packages/suite/src/run-suite.ts`) — per-case isolation: a thrown dispatch becomes a `pass:false` failed `CaseResult`, the batch keeps going. Never route a batch via `RunService.submit`.
3. Aggregate/compare only via `@everdict/domain` pure fns (`summarizeScorecard`/`diffScorecards`/`leaderboard`/`trendSeries`) — they take the light `ScorecardRecord` shape, no `@everdict/db` dep.
4. Judge = a **model grader** (`JudgeGrader`), constructed where a `Judge` is injected — NOT in `makeGraders`. Scores land under metric `judge:<id>`.
5. External model/HTTP failure in a transport → `UpstreamError` (never raw).

## Reference impl
`apps/api/src/execution/scorecard-service.ts` — the batch lifecycle: dataset resolve (404) → `queued` record (202)
→ `runSuite` (per-case child runs, admit/settle budget, cooperative `AbortSignal` supersede/**user cancel**) with **streaming
judges** (each case is pushed into `ScoringService.createJudgeStream` from `onResult` the moment it completes —
bounded case-axis parallelism, deterministic per-case judge order; the `judges` phase after dispatch is just
`settle()`, the join) → offload → aggregate (`summarizeScorecard`+`scorecardModels`) → persist. Scoring is
split out to `apps/api/src/execution/scoring-service.ts` (`ScoringService.createJudgeStream`/`applyJudges`(=push-all+settle,
used by ingest)/`collectJudgeModels`). See `docs/architecture/streaming-case-pipeline.md`.

**Stop/cancel.** `ScorecardService.cancel(tenant,id)` (`POST /scorecards/:id/cancel` + `cancel_scorecard`) stops a
queued/running batch → new terminal `cancelled` status (domain `ScorecardBatch.cancel`/`canCancel`; like
`superseded`, excluded from baseline/diff/leaderboard/trend, which positively filter `succeeded`). It shares the
supersede `stopInFlight` seam: cooperative abort (no more cases fire) + `cancelQueued`/`cancelLeased`/`killCase`, so
managed Nomad/K8s jobs are force-killed and **self-hosted lease jobs abort on the runner's next heartbeat**
(`RunnerHub.requestCancel` → `heartbeat_job {cancelled}` → an `AbortSignal` down runner-loop→`runLeasedJob`→`runCase`
→ `compute.dispose()` = `docker rm -f` / process-group kill). Terminal → 409, cross-workspace/missing → 404. See `docs/scorecards.md`.

## Scoring model — Grader-only (recently consolidated — IMPORTANT)
Scoring is unified to **Graders**. There is no separate "scorer", and the **Metric(threshold) entity is
removed from the engine** (mig `packages/db/migrations/0034_drop_metrics.sql` dropped `everdict_metrics`; 0 real usage).
KEEP: `Score.metric` as a free **label**, `MetricSummary`, and `metric` as a trend/leaderboard **axis**.
Grader families (`packages/graders/src/index.ts`): outcome `tests-pass`/`command`/`swe-bench`/`script-score`
(need `ctx.compute` — guard, it's optional); trace `steps`/`cost`/`latency` (`trace-graders.ts`, read ONLY
`ctx.trace`); browser `dom-contains`/`url-matches`/`answer-match`; model `judge`. No-dep graders reconstruct
from `GraderSpec` in `makeGraders` (`packages/graders/src/make-graders.ts`); `judge` throws there (needs a `Judge`).
Case verdict is **authority-ranked** (`packages/suite/src/scorecard.ts` `caseVerdict`): ground-truth
(`state`/`tests_pass`) > objective (`answer_match`/`url_matches`/`dom_contains`) > `judge` — a VLM/LLM judge
never overturns an objective grader. `scorecardPassRate` aggregates over `caseVerdict`; `summarizeScorecard`
gives per-metric count/mean/passRate (auto).

## Agent Judges
A judge splits pure **prompt-build + verdict-parse** (`modelJudge`, `packages/graders/src/model-judge.ts`,
testable) from an injected **transport** `JudgeCompletion`: `anthropicComplete` / `openaiComplete`
(OpenAI-compatible → LiteLLM via `baseUrl`) / `harnessComplete` (dispatch an agent harness, verdict from its
trace via `traceToText`). `JudgeGrader` (`packages/graders/src/judge.ts`) wraps it; `useScreenshot` feeds the
snapshot to a VLM. Judges are user-registered `model`|`harness` `JudgeSpec`s (`@everdict/registry`). The control
plane builds the right transport from the spec + the tenant's SecretStore key/dispatcher:
`apps/api/src/core/execution/judge-runner.ts` `defaultJudgeRunner` (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, model-registry
resolve, missing key ⇒ explicit `skip` score, never silent). Score metric = `judge:<id>`.
Custom prompts: `JudgeSpec.promptTemplate` (placeholders incl. mandatory `{verdict_instruction}`, schema-enforced);
multi-criteria: `JudgeSpec.criteria[]` → ONE model call scores each criterion (`judge:<id>:<criterion>`) + the
weighted overall (`judge:<id>`). See `docs/judges.md` + `docs/architecture/eval-domain-model.md`.

## Batch aggregation, regression & leaderboard
- `diffScorecards(baseline, candidate)` (`packages/suite/src/scorecard.ts`) — same-case metric delta +
  objective `pass` transitions → `regressions`/`improvements`. Route `GET /scorecards/diff`.
- `leaderboard(cards, opts)` (`packages/suite/src/leaderboard.ts`) — groups by `(harness@version × model.primary)`,
  ranks by passRate→mean, `window: latest|best`, per-`metric` axis, optional `judgeModel` fair-compare filter.
- Model axis (`packages/suite/src/models.ts` `scorecardModels`): **observed** (distinct `llm_call.model` from the
  trace) + **declared** (command harness `spec.model`) both kept; `primary` = mode observed → declared fallback.
  Persisted as `models` jsonb (mig `0028_add_scorecard_models.sql`); judge models mig `0030`.
- Trend/regression-over-time: `trendSeries` (`packages/suite/src/trend.ts`), route `GET /scorecards/trend`.

## Trace ingest (no harness run)
`POST /scorecards/ingest` (push): upload externally-run `TraceEvent[]`; re-derive trace graders
(steps/cost/latency) + keep uploaded scores, then judge + aggregate (`ScorecardService.ingest`).
`POST /scorecards/ingest/pull`: pull per-run traces from the tenant's platform via `@everdict/trace`
`buildTraceSource` — kinds `otel|mlflow|langfuse|langsmith|phoenix` (`source.authSecret` → SecretStore value;
otel/mlflow = verbatim `Authorization` header, the newer three place the value in their platform's header —
langsmith `x-api-key`; phoenix needs `source.project`), then score.

## Trace sink (export judged detail OUT — outbound mirror of ingest)
The workspace registers **named sinks** (`WorkspaceSettings.traceSinks[]`: MLflow/Langfuse/LangSmith/Phoenix,
routes `/workspace/trace-sinks*`), and each **harness opts in** by selecting one
(`traceSinkByHarness`, `PUT /harnesses/:id/trace-sink`, member+). The pipeline exports the selecting
harness's case trace+scores to that platform — **streaming, per case as its judging completes** (D5:
`TraceSinkService.exportStream` `{push,settle}`; the orchestrator chains `JudgeStream.push`'s per-case
completion promise → `export push`; `exportScorecard` = push-all+settle, used by ingest + fallback) —
records the outcome on
`ScorecardRecord.export` (mig 0048 `sink_export` jsonb, detail-only like `steps`), and the web shows summary +
deep links. **Export failure NEVER fails the scorecard** (outcome-only; `error.phase` untouched). Pull-ingest
whose `source.kind` equals the sink kind **attaches scores to the original trace** (no duplication) — the
`runs[{caseId,runId}]` mapping flows through as `attach`. SSOT `docs/architecture/trace-sink.md` + rule `trace`.

## Saved Views
`apps/api/src/workspace/view-service.ts` + `packages/db/src/results/view-store.ts` — private|workspace saved scorecard-analysis
lenses (opaque `config`, live re-run). AuthZ **reuses** `scorecards:read` (read) / `scorecards:run` (write) —
no new action; edit/delete = owner or admin. See `docs/architecture/scorecard-analysis-views.md`.

## Execution/scoring/orchestration separation
Three concerns stay split: `apps/api/src/execution/execute-case.ts` (`executeCase` = pure exec: token resolve + attach +
dispatch) · `ScoringService` (scoring on a trace) · the services (`ScorecardService`/`RunService` orchestrate
lifecycle, budget, child runs). Live batch and ingest share the SAME scoring path. See
`docs/architecture/execution-scoring-orchestration.md`.

See `docs/scorecards.md` · `docs/judges.md` · `docs/suites.md` ·
`docs/architecture/leaderboard-model-dimension.md`. Rule `.claude/rules/graders.md` has the inlined grader rules.
