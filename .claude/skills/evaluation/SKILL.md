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
1. Score = `{graderId, metric, value, pass?, label?, detail?, status?, reason?, retryable?}` (`@everdict/contracts`). A grader reads trace + snapshot, never mutates. `value` is always a number; a **categorical** outcome (tier/string/enum — "gold" | "correct" | "timeout") sets `label` (with `value` as the ordering key: `1<2<3` for an ordered enum, `0` for an unordered one), which flips the metric to a **distribution** summary (see checklist 3). **Measurement status**: absent = `"measured"`; a grader failure/skip emits `status:"unmeasured"` + `reason` (closed vocab `UNMEASURED_REASONS`) + `retryable` (`safeGrade` → `grader_error`, judge-runner `skip()` → `missing_secret`/`unsupported`/…). EVERY aggregate (mean/passRate/distribution/verdict/diff) filters through the `isMeasured`/`measuredScores` gate (contracts) — a dead grader is never a 0; legacy pre-status rows normalize at read via their `[grader-error]`/`skipped: ` detail sentinels. Per-metric `unmeasured` tallies ride `MetricSummary`; `retryableUnmeasured(sc)` (domain) is the targeted re-score worklist.
2. Batch always through `runSuite` (`packages/application-control/src/run-suite.ts`) — per-case isolation: a thrown dispatch becomes an `infra_failed` `CaseResult` (classified `failure` + an UNMEASURED diagnostic score — never a product FAIL), the batch keeps going. Never route a batch via `RunService.submit`.
3. Aggregate/compare only via `@everdict/domain` pure fns (`summarizeScorecard`/`diffScorecards`/`leaderboard`/`trendSeries`) — they take the light `ScorecardRecord` shape, no `@everdict/db` dep.
4. Judge = a **model grader** (`JudgeGrader`), constructed where a `Judge` is injected — NOT in `makeGraders`. Scores land under metric `judge:<id>`.
5. External model/HTTP failure in a transport → `UpstreamError` (never raw).

## Reference impl
`apps/api/src/execution/scorecard-service.ts` — the batch lifecycle: dataset resolve (404) → `queued` record (202)
→ `runSuite` (per-case child runs, admit/settle budget, cooperative `AbortSignal` supersede/**user cancel**) with **streaming
judges** (each case is pushed into `ScoringService.createJudgeStream` from `onResult` the moment it completes —
bounded case-axis parallelism, deterministic per-case judge order; the `judges` phase after dispatch is just
`settle()`, the join) → offload → aggregate (`summarizeScorecard`+`scorecardModels`) → persist. **The judge is
downstream of a produced outcome**: `createJudgeStream.push` skips a result with a set `failure` (`isGradeable` — a
pre-trace/dispatch death has no real trace/snapshot, so judging it burns provider tokens for a spurious `judge:<id>`
score) and tallies `stats()` (`pushed`/`gradeable`/`skipped`); the `judges` phase reports it — `judges skipped: 0
gradeable traces (N/N failed pre-trace)` when every case died — instead of a misleading "judges applied". Scoring is
split out to `apps/api/src/execution/scoring-service.ts` (`ScoringService.createJudgeStream`/`applyJudges`(=push-all+settle,
used by ingest)/`collectJudgeModels`). See `docs/architecture/streaming-case-pipeline.md`.

**Recover transient scoring.** `POST /scorecards/:id/rescore-unmeasured` (+ MCP `rescore_unmeasured_scores`,
wire `RescoreUnmeasuredResultSchema {id, rescoredJudges, skipped}`) — re-runs ONLY the judges behind the
batch's retryable-unmeasured scores (`retryableUnmeasured` worklist — GRADEABLE cases only: a classified
failure recovers through retry/re-collect, never a scoring pass), in place via `scoreGroup` under the batch's
OWN judge pins (never a silent latest upgrade); non-judge unmeasured (in-job grader deaths) return as
`skipped` — they need `/retry`. No case re-execution. Both scoring passes (in-process `track` AND the
Temporal `planScore`/`scoreCase` bridge) answer "already judged?" and "which rows does a re-score replace?"
through ONE predicate set (`hasMeasuredJudgeVerdict`/`stripJudgeScores`/`isJudgeMetricOf` in
scorecard-shared): a MEASURED `judge:<id>` verdict = done (an unmeasured placeholder is the state the pass
exists to replace, never "done"), and the strip removes the whole `judge:<id>` prefix family (verdict +
criterion children + placeholders) so a re-score replaces rather than accretes. An UNRESOLVABLE selected
judge (deleted/bad version) is never silently dropped: `ScoringService.resolveJudges` returns it and the
stream stamps a per-case `unmeasured{unsupported, retryable:false}` row — a batch never settles claiming a
judge it did not run.

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
Case verdict is **authority-ranked and POLICY-DRIVEN** (`packages/domain/src/scorecard/verdict-policy.ts`):
the ladder — ground-truth (`state`/`tests_pass`, priority-ordered) > objective (`answer_match`/`url_matches`/
`dom_contains`, unanimous) > judge (`judge` + top-level `judge:<id>`, unanimous; criterion/milestone metrics
are diagnostic and never decide) — is DATA (`DEFAULT_VERDICT_POLICY`, versioned + FNV digest), not metric-name
string arrays. `evaluateVerdict(result, policy)` returns `{verdict, basis}` — the basis names the deciding
rung/aggregation/measurements (served as `verdictBasis` per case); `caseVerdict` is its boolean view. Duplicate
metrics combine unanimously (never Map last-wins); a pre-outcome failure (dispatch/install/run) yields NO
verdict (`caseOutcome` = completed|unmeasured|infra_failed; `scorecardOutcomes` serves the denominators).
**Every settled batch stamps `verdictPolicy{id,version,digest}`** (domain `judgedUnder`, mig 0125) and readers
resolve the STAMPED policy — evolving the policy never rewrites historical verdicts; new policy versions are
APPENDED to `KNOWN_VERDICT_POLICIES`, never edited. Resolution is **THREE-state and FAIL-CLOSED**
(`resolvePolicyResolution` → `resolved` | `legacy_default` (no stamp at all — pre-mig rows really were judged
under the ladder) | `unresolvable`), and `unresolvable` — manifest gone, digest mismatched, or an id@version
nobody has — must NEVER fall back to the default: doing so re-judges history under today's ladder. A verdict
or gate decision therefore withholds itself instead (served `policyResolution:"unresolvable"` ⇒ no per-case
`verdict`/`casePass`/`outcomes`; gate ⇒ `not_comparable` + reason `policy_unresolvable`). `caseVerdict`/
`caseOutcome`/`caseTrialStats`/`summarizeTrials`/`scorecardOutcomes` all TAKE the policy — a caller holding a
stamped record resolves it and passes it; the default parameter is only for subjects with no stamp (a single
`RunRecord`, a live case mid-batch under the composed document in hand). List reads carry no manifest, so a
composed stamp resolves `unresolvable` by construction — that is the list-path guard. **Run-time declarations compose
the policy**: a `GraderSpec` may declare `authority`/`direction` for its metric (`composeVerdictPolicy` —
appended AFTER the built-ins, so custom ground truth never outranks state/tests_pass); the composed document
is embedded IN FULL in `manifest.verdictPolicy` (mig 0126) and trusted at read only when its digest matches
the stamp. **Constitution gate #1**: declaring `ground_truth` requires the admin role at submit (both
transports pass `submitterRoles`). `MetricDefinition` also carries `kind`/`verdictRole`(required/supporting/
diagnostic/excluded)/`missingPolicy` — a REQUIRED metric with no measurement INVALIDATES the case (verdict
absent with a stated cause). `caseOutcome` adds `cancelled` (failure code CANCELLED — no verdict at any
stage, own denominator); `requested` (cases×trials / ingest trace count, mig 0127) persists the ask.
`evidenceStatus` reads the producer's `traceSealed` vouch (runCase) — the only positive claim of trace
completeness. trend/leaderboard flag `policyMixed` and suppress cross-policy regression flags; diff lists
`incomparable` (kind_changed) + `overlap`. `preferredMetric` resolves absent metric axes from the data. **The ranking has exactly one
implementation and is SERVED, never recomputed by a client**: a scorecard's per-case `verdict` and
`RunRecord.verdict` (derived on read next to `usage`, in `withRunUsage`) both come from this engine, and the
web's client-side mirrors were deleted in re-architecture P1g. A surface that needs "did this pass" reads the
served field.
`scorecardPassRate` aggregates over `caseVerdict`; `summarizeScorecard`
gives per-metric count/mean/passRate (auto) — plus, for a metric whose scores carry `label`, a
`distribution` (label→count; ordinal order for an ordered enum, else by frequency) + `mode` instead of a
meaningless mean. Two exclusion rules there: `mean` is ABSENT when count is 0 (an annihilated metric — every
score unmeasured/invalid — must never read as a measured zero; consumers gate on the absence, which the
optional type forces), and a NO-OUTCOME case (failure code CANCELLED at any stage, or a pre-outcome
dispatch/install/run death) contributes NOTHING to the metric plane — its story lives on
`caseOutcome`/`scorecardOutcomes`; only collect-stage failures keep their compute-bound measurements.
`classifyFailure` marks CANCELLED non-retryable (a retry would un-stop a stop), and runCase records a
`compute.dispose()` failure on the lifecycle mark instead of destroying the finished result. The web dashboard is
**metric-kind-aware** (`classifyMetric`/`fmtMetricValue` in `apps/web/.../format.ts`): categorical → distribution
bar, pass/fail → proportion bar, numeric → the mean in its inferred unit ($ / s / % / count) — never a raw `0.50`.

## Agent Judges
**The authoring surface is the CODE judge** (`kind:"code"`, `docs/judges.md`): user Python/Node code over the
serialized judge context (`{case, trace, snapshot, evidence}` — the script-grader contract), run SANDBOXED via a
dispatched wrapper job (never on the control plane; `runCodeJudge` in `judge-runner.ts` — no-op command harness +
script grader `contextPath`); `spec.model` rides `job.judge` → `EVERDICT_JUDGE_MODEL/PROVIDER` + provider key env.
The wizard dry-run (`POST /judges/try`, code kind) **promotes the wrapper job to a real standalone run**
(`trigger:"judge-preview"`, inline `harnessSpec`; sanctioned seam `codeJudgeRunSubmitter` → `RunService.submit` —
see `docs/architecture/execution-scoring-orchestration.md`) and returns `{runId}` — progress/logs/verdict ride
the run surfaces; the batch scoring path keeps dispatching inline.
Legacy engine kinds (`model`|`harness`) keep running for existing specs but new registration exposes code only.
A model judge splits pure **prompt-build + verdict-parse** (`modelJudge`, `packages/graders/src/model-judge.ts`,
testable) from an injected **transport** `JudgeCompletion`: `anthropicComplete` / `openaiComplete`
(OpenAI-compatible → LiteLLM via `baseUrl`) / `harnessComplete` (dispatch an agent harness, verdict from its
trace via `traceToText`). `JudgeGrader` (`packages/graders/src/judge.ts`) wraps it; `useScreenshot` feeds the
snapshot to a VLM. The control
plane builds the right transport from the spec + the tenant's SecretStore key/dispatcher:
`apps/api/src/core/execution/judge-runner.ts` `defaultJudgeRunner` (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, model-registry
resolve, missing key ⇒ explicit `skip` score, never silent). Score metric = `judge:<id>`.
Custom prompts: `JudgeSpec.promptTemplate` (placeholders incl. mandatory `{verdict_instruction}`, schema-enforced);
multi-criteria: `JudgeSpec.criteria[]` → ONE model call scores each criterion (`judge:<id>:<criterion>`) + the
weighted overall (`judge:<id>`). **A judge execution is never free or invisible**: the runner tees the
transport's usage / keeps the dispatched job's trace, METERS it (usage source `judge` + budget settle,
`meterJudgeCost` in composition) and SEALS it as a `judge:<id>` plane on the judged case's child run trajectory
(`runIdOf` threads batch/track/re-score → `JudgeRunner.run(..., runId)`; ingest has no child, so meter-only) —
beside the execution plane, never inside it, so judged evidence and harness billing stay clean. See
`docs/judges.md` §"Judge executions leave evidence" + `docs/architecture/usage-metering.md`.
See `docs/judges.md` + `docs/architecture/eval-domain-model.md`.

## Batch aggregation, regression & leaderboard
- `diffScorecards(baseline, candidate)` (`packages/domain/src/scorecard/scorecard.ts`) — **comparability
  FIRST**: `comparability: full|partial|none` ("none" = the comparison does not hold — a different claim from
  "no differences"; gates read it before any delta), `missing` enumerates one-sided cases/metrics (never a
  silent skip, never a `?? 0` zero-fill), `metrics` covers BOTH-sided metrics only with `direction`+`reading`
  (declared in the verdict policy — `delta>0` is never generalized as improvement; cost up = regressed), plus
  same-case `pass` transitions → `regressions`/`improvements`. The service layer forces `comparability:"none"`
  + `policyMismatch` when the two batches' stamped verdict-policy digests differ. `diffTrials` gates small
  samples (<30 trials) by **Fisher's exact test** (z is overconfident at eval-scale n; 3/3→0/3 is honestly
  p=0.1) and applies the `minDelta` practical floor — statistically-significant-but-negligible dips stay out;
  skipped cases ride `missing`. The diff also carries `coverage` (`measurementCoverage` per side: how many of
  its scores were actual measurements) — aggregates already drop unmeasured scores, so a hollowed-out batch
  reads as healthy and the ratio has to travel WITH the comparison. Route `GET /scorecards/diff`.
- `evaluateGate(diff, policy)` (`packages/domain/src/scorecard/gate.ts`) — the CI decision, **fail-closed**:
  four outcomes `pass | block | blocked_missing | not_comparable`, and only the first is a green light.
  `not_comparable` = the comparison does not hold (`comparability: "none"`); `blocked_missing` = it held but
  not over enough. `GatePolicy.comparability` defaults to `require_full` **in the domain fn, never as a Zod
  default** (the policy embedded in a recorded decision must stay exactly what the caller sent, so old digests
  survive schema growth); `allow_partial` + `maxMissingCases`/`maxMissingFraction` is how a caller decides on a
  subset deliberately, and `maxUnmeasuredFraction` applies under either mode (unmeasured scores hollow a
  comparison out without ever making it `partial`). `zThreshold`/`minDelta` on the policy are the trials diff's
  bar — the gate computes the diff under its OWN statistical policy. Both blocking decisions are overridable
  (recorded, with who and why); `gateAudit` counts them separately.
- `leaderboard(cards, opts)` (`packages/domain/src/scorecard/leaderboard.ts`) — groups by
  `(harness@version × model.primary)`, ranks by passRate→mean **under the metric's policy-declared direction**
  (rank 1 = BEST: `?metric=cost_usd` puts the cheapest first, not the most expensive), `window: latest|best`,
  optional `judgeModel` fair-compare filter. `trendSeries` likewise flags `regressed` direction-aware and
  serves `direction` (absent = unknown ⇒ nothing flagged, deltas uncolored) — never interpret a delta's sign
  alone. The **served `headlinePassRate` rides list AND detail** (`serveScorecardListItem`); a client never
  re-derives a representative metric from summary order.
- Model axis (`packages/suite/src/models.ts` `scorecardModels`): **observed** (distinct `llm_call.model` from the
  trace) + **declared** (command harness `spec.model`) both kept; `primary` = mode observed → declared fallback.
  Persisted as `models` jsonb (mig `0028_add_scorecard_models.sql`); judge models mig `0030`.
- Trend/regression-over-time: `trendSeries` (`packages/suite/src/trend.ts`), route `GET /scorecards/trend`
  + MCP twin `trend_scorecards` (direction/policyMixed semantics reach agents too — BFF↔MCP parity).
- Flexible analysis pivot: `computeAnalysis` (`packages/domain/src/scorecard/analysis.ts`) — filter/group/pivot/
  measure over the light list shape; route `POST /scorecards/query` + MCP `query_scorecards`. It is the
  **server-side twin of the web engine** (`apps/web/.../analyze-scorecards/model/analysis.ts`) — change BOTH in
  lockstep. `GET /scorecards/:id/analysis` + `get_scorecard_analysis` fetch the offloaded `analysisRef` bundle
  server-side (http-only ref → else 404). See `docs/architecture/analysis-studio.md`.

## Trace ingest (no harness run)
`POST /scorecards/ingest` (push): upload externally-run `TraceEvent[]`; re-derive trace graders
(steps/cost/latency) + keep uploaded scores, then judge + aggregate (`ScorecardService.ingest`).
`POST /scorecards/ingest/pull`: pull per-run traces from the tenant's platform via `@everdict/trace`
`buildTraceSource` — kinds `otel|mlflow|langfuse|langsmith|phoenix` (`source.authSecret` → SecretStore value;
otel/mlflow = verbatim `Authorization` header, the newer three place the value in their platform's header —
langsmith `x-api-key`; phoenix needs `source.project`), then score.
**`dataset`/`harness` are OPTIONAL on both ingest paths** — omit them to score the traces DIRECTLY: each trace becomes
its own synthesized case (judges only, no `expected`) and the record carries the reserved sentinel `TRACE_EVAL_REF`
(`"_traces"`, `@everdict/contracts`) as dataset+harness (NO migration; consumers detect a trace-evaluation by
`dataset.id === TRACE_EVAL_REF`; leaderboard/trend self-exclude it). This is the web **"Evaluate traces"** mode (pick
traces from a source + judge). A named-source pull may pass `source.correlate` to override the pooled setting — the
evaluate-traces flow forces `"id"` (it holds the platform's real trace ids from `listTraces`). See `docs/scorecards.md`.

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
