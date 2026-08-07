# Scorecards (batch eval: dataset × harness → aggregated result)

A **scorecard run** evaluates a whole **dataset** (N cases) against one `harness@version` and aggregates the
per-case results into a `Scorecard` + a per-metric `summary`. It's the eval payoff — the second step of the
pipeline and the input to baseline comparison (next increment):

```
Dataset → [scorecard run] → trace → agent-judge → scorecard → dashboard / baseline-compare
```

## How it works (`apps/api` `ScorecardService`)
1. Resolve the **dataset** (`DatasetRegistry`, owner-first/`_shared` fallback) → its cases. Missing → `404`.
   The request's optional **`cases`** selects a **subset** (partial run — cost control / smoke): `ids`
   (explicit; unknown id ⇒ `400`, never a silent partial) → `tags` (any-match) → `limit` (first N), applied in
   that order; empty selection ⇒ `400`. The record stamps **`subset {total, selected, ids?, tags?, limit?}`**
   (mig 0043, returned in list too) so every consumer (list/detail/diff/leaderboard) can see it's not a full
   run — the web shows a "partial n/N" chip (list) and a case-selection prop (detail), and the run form exposes
   a case-count limit + tag filter. Omitted ⇒ full dataset, no stamp.
2. Resolve the **harness version** (`latest → concrete`) via the registry; embed the `HarnessSpec` for
   declarative harnesses (builtins fall back to id). The record stores the **resolved** `harness@version`.
3. Build a `Suite` on the fly (`{ id: dataset.id, harness: { id }, cases }`) and run it with `@everdict/application-control`'s
   `runSuite` over the **same dispatcher** single runs use — each case becomes one job (tenant + budget
   admit/settle per case, concurrency-limited). The request's optional **`concurrency`** (1–64) sets how many
   cases dispatch at once (`runSuite` fan-out); omitted ⇒ service default (4). For a **self-hosted** runtime
   the parked jobs only run as fast as the runner leases them — match it with `everdict runner --max-concurrent N`
   (effective case-level parallel = `min(concurrency, runner workers)`).
4. Aggregate with `summarizeScorecard` → store `{ status, summary, scorecard }`.

**Child runs (run = the primitive; scorecard = run × N).** Each case is dispatched through the **same
`executeCase` lifecycle** a single `POST /runs` uses (repo-token → dispatch → self-hosted-aware settle), and
— when a `runStore` is wired — each case also becomes an addressable child `RunRecord`
(`parentScorecardId` = this scorecard, `trigger: "scorecard"`, full trace/usage/provenance). The scorecard
records their ids in `runIds`. Child runs are **hidden from the default run/activity list**
(`RunStore.list` filters `parentScorecardId IS NULL`) so a batch doesn't flood it; fetch a batch's children with
`list(tenant, {scorecardId})` (`GET /runs?scorecardId=` / MCP `list_runs scorecard_id`), which powers the scorecard
detail's case→run drill-down. The activity console can also show **all executions at once** —
`list(tenant, {includeChildren})` (`GET /runs?scope=all` / MCP `list_runs scope:"all"`), where the web groups
children under their scorecard. The scorecard is the eval lens; the run list is the execution lens over the same runs.
**Storage is deduped**: a dispatched scorecard stores `runIds` only (not the heavy `scorecard` embed) — `track`
writes the final (post-judge/offload) results back to the child runs, and `ScorecardService.get` **hydrates**
the `scorecard` from them, so the response shape, web, and diff are unchanged. `no-runStore` runs, ingest paths, and
old records keep the embed. See `docs/architecture/run-as-primitive.md`.

Runs are **async**: submit returns a `queued` record; poll until terminal. Normal eval failures produce
`CaseResult`s (the batch still succeeds); only infra/budget errors fail the whole run.

**Failure visibility** (diagnose "at which stage and how"): a per-case dispatch failure is isolated to a failed
`CaseResult` carrying `trace:[{kind:"error",message}]` + a `pass:false` score whose **`detail` = the reason**
(so the web/CLI shows *why* per case). A pipeline-level failure tags the record's `error.phase`
(`dispatch | judges | offload | persist`) so you see *which stage* broke, and the **partial
`scorecard`** (case results gathered before the failing stage) is persisted on the failed record too.

**Progress (steps timeline)** — not a percentage; the *process*. The run appends `ScorecardRecord.steps[]`
(`{ts, phase, status, message, caseId?}`) and **persists incrementally**: dispatch-started, one step **per case
as it completes** (`onResult` from `runSuite` → `caseId → PASS/FAIL · reason`), judges start+done, then
persist. The detail page renders this as a timeline and **auto-refreshes** (`router.refresh()`) while the run is
`queued`/`running`. `steps` is heavy detail → returned by `get`, **omitted from `list`** (like `scorecard`);
Pg column `steps jsonb` (migration `0026`).

## Storage (`@everdict/db`)
`ScorecardStore` (`InMemoryScorecardStore` / `PgScorecardStore`), mirror of `RunStore`. `ScorecardRecord` =
`{ id, tenant, dataset:{id,version}, harness:{id,version}, status, summary?, createdBy?, scorecard?, error?, …}`.
**`list` omits the heavy `scorecard`** (traces) — only `summary` — so the list is cheap; `get` returns the full
record. `createdBy` = the submitter's `principal.subject`, stamped on submit **and** both ingest paths (the *who*
to `origin`'s *where*; older records / machine principals may lack it) — lightweight, so included in `list` for
the web's author display + user filter (same pattern as datasets/harnesses `created_by`).
Migrations: `packages/db/migrations/0006_create_scorecards.sql`, `0035_add_scorecard_created_by.sql`.

## The stamped verdict policy resolves in THREE states (fail-closed)
Verdicts are derived on READ, so every settled batch stamps the policy it was judged under
(`ScorecardRecord.verdictPolicy` = `{id, version, digest}`, mig 0125), and a **composed** policy — one a
run-time grader's `authority`/`direction` declaration built — rides IN FULL in `manifest.verdictPolicy`
(mig 0126), because that document exists nowhere else.

`resolvePolicyResolution(ref?, embedded?)` (`@everdict/domain`) answers with a status, never just a policy:

| status | when | what readers do |
| --- | --- | --- |
| `resolved` | the embedded document's digest matches the stamp, or the stamp names an entry in the append-only `KNOWN_VERDICT_POLICIES` whose document still hashes to it | derive verdicts under that document |
| `legacy_default` | there is **no stamp at all** (pre-mig-0125 rows) | derive under `DEFAULT_VERDICT_POLICY` — those batches really were judged under the ladder it encodes |
| `unresolvable` | a stamp IS present and its document cannot be produced: manifest absent, digest mismatched (tampered/edited), or an id@version nobody has | **withhold the verdict** — never re-judge under today's ladder |

`unresolvable` is the whole point. Falling back to the default there rewrites history silently: a composed
policy's custom ground truth disappears and the built-in ladder re-decides every case. Concretely:
- **Serving** (`apps/api/.../serve.ts`): the detail response carries `policyResolution`, and on `unresolvable`
  the per-case `verdict`/`verdictBasis`, `casePass` and `outcomes` are **absent** (`evidenceStatus` still
  rides — it reads the result alone). The web shows a callout instead of a rollup; it never renders a 0%.
- **Comparing** (`GET /scorecards/diff`): each side resolves its OWN policy, and each side's trials are
  counted under it (`diffTrials` takes `baselinePolicy`/`candidatePolicy`). An unrestorable side sets
  `policyUnresolvable` and forces `comparability: "none"`.
- **Gating** (`evaluateGate`): `policyUnresolvable` ⇒ `not_comparable` with reason `policy_unresolvable` —
  checked BEFORE the comparability branch, so the refusal does not depend on the caller marking the diff.
- **List reads** carry the stamp but not the manifest. A composed stamp (`id: "composed"`, never in the
  registry) therefore resolves to `unresolvable` **by construction** — that is the list-path guard.
- **Other derivations** follow the same rule: `flakeIndex` and `workspaceOpsReport` skip an unresolvable
  record, `ScorecardBatch.withTrialSummary` omits the roll-up, the regression watch never reopens an issue on
  one, and `retryFailed` refuses with a 400 rather than picking cases by re-judging them.

## Experiments (ungraded phase-1 groups — execution-model P1)
An **experiment** is a scorecard row that stopped after phase 1 (decision O3: the RunGroup generalizes
`ScorecardRecord` in concept, the table is kept — `kind:"experiment"`, mig `0093`): the SAME fan-out and child
runs, with every grader stripped and no judges, so `caseVerdict` stays `undefined` end to end — the child runs
and their trajectories are the product ("does this harness even work / what does it do"). Submit via
`POST /groups` / MCP `run_experiment` with EXACTLY ONE of `dataset` (registered cases, graders removed for this
group only — the dataset stays pure data) or `task:{prompt}` (a one-off case under the `EXPERIMENT_ADHOC_REF`
(`_adhoc`) sentinel — **not re-drivable** after a control-plane restart, since there is no registry entry to
re-plan from); `trials` repeats it N times. Read back through `GET /groups/:id` or the scorecard surface (one
table). Leaderboard/trend/analysis exclude `kind:"experiment"` at the store filter; the list shows both, badged.

**Phase 2, detached (P2 — `POST /groups/:id/score` / MCP `score_group`)**: apply judges over an EXISTING
group's runs and re-write the aggregate — phase 1 is never re-executed. Judge verdicts attach to the child
runs (write-back; `get` hydrates from them), the fresh `summary`/`judgeModels` to the group, and a
`scorecard.scored` platform fact rides the E0 outbox (`ScorecardBatch.rescore` — the transition computes it).
Re-scoring a judge REPLACES its previous `judge:<id>` verdicts (idempotent by metric); scoring an
**experiment promotes it** — `kind` flips to the explicit `"scorecard"` (a group with a verdict is
definitionally a scorecard, O3). Async: 202 returns the record as-of submission; poll until the aggregate
moves (a failed pass appends a `judges`-phase step instead of touching the settled status). Guards: only a
`succeeded` group scores (409), one pass in flight per group (409), no results → 400. The group's
`orchestration.judges` (the submit-time re-drive plan) is deliberately NOT rewritten — after-the-fact judges
are visible via `judgeModels` + the `judge:<id>` summary rows. The batch pipeline's inline judging is
unchanged (conceptually the same operation; convergence is a later refactor).

**Score-on-Temporal (T-c)**: with `EVERDICT_TEMPORAL_ADDRESS` configured, a runIds-backed group's scoring
pass runs as a durable `scoreGroupWorkflow` (`everdict-score-<groupId>`) over the same internal bridge the
batch uses (`/internal/groups/:id/score-plan|score-case|score-finalize`): `planScore` is idempotent
(unfinished child keys only — keyed `<caseId>#<trial>`), `scoreCase` judges ONE child and skips if already
judged, `finalizeScore` re-aggregates. Kill the control plane mid-pass and the pass resumes with ZERO
duplicate judging. The deterministic workflowId is the one-pass-per-group dedup (a second score → 409);
start failure degrades to the in-process pass; embed-mode groups (no child runs to write back to) always
take the in-process pass. See `docs/orchestration.md` (Tier-1 item 3).

## BFF ↔ MCP parity
| HTTP route | MCP tool | Action |
|---|---|---|
| `POST /scorecards` `{dataset, harness, judges?, runtime?, concurrency?, cases?{ids,tags,limit}}` → 202 | `run_scorecard` | `scorecards:run` (member+) |
| `POST /groups` `{harness, dataset \| task:{prompt}, trials?, runtime?}` → 202 (P1 experiment; read = `GET /groups/:id` ↔ `get_scorecard`) | `run_experiment` | `scorecards:run` (member+) |
| `POST /groups/:id/score` `{judges[]}` → 202 (P2 detached scoring; re-score replaces, experiment promotes) | `score_group` | `scorecards:run` (member+) |
| `POST /scorecards/:id/cancel` → 200 (the cancelled record) | `cancel_scorecard` | `scorecards:run` (member+) |
| `POST /scorecards/ingest` `{dataset?, harness?, traces[], judges?}` → 202 | `ingest_scorecard` | `scorecards:run` (member+) |
| `POST /scorecards/ingest/pull` `{dataset?, harness?, source{name\|kind,endpoint,authSecret?}, runs[], judges?}` → 202 | `pull_scorecard` | `scorecards:run` (member+) |
| `GET /scorecards` (summary only) | `list_scorecards` | `scorecards:read` (viewer+) |
| `GET /scorecards/:id` (full) | `get_scorecard` | `scorecards:read` |
| `GET /scorecards/diff?baseline=&candidate=` | `diff_scorecards` | `scorecards:read` |
| `POST /scorecards/query` `{filters?, groupBy?, pivotBy?, metric?, measure?, viz?, sort?, search?}` | `query_scorecards` | `scorecards:read` |
| `GET /scorecards/:id/analysis` (the offloaded analysis bundle, fetched server-side) | `get_scorecard_analysis` | `scorecards:read` |

`POST /scorecards/query` is the **flexible analysis pivot** — the server-side twin of the web analyze
dashboard's engine (`@everdict/domain computeAnalysis`; the two stay in lockstep): filter/group (0..2 dims)/
pivot/measure (`passRate|mean|count|latest`) over the lightweight list shape, `viz: table|bars` → grid rows,
`viz: line` → time-bucketed series. Incomplete batches (queued/running/superseded/cancelled) are excluded
unless `includeIncomplete`. `GET /scorecards/:id/analysis` returns the self-contained analysis artifact
(`analysisRef`: summary + per-case verdicts/scores) as one JSON document — 404 when the record has no artifact.
It reads the object by KEY (`analyses/<id>.json`) through the `ArtifactStore`, falling back to fetching the ref
only for an artifact this deployment's store doesn't hold: the stored ref is a PRESIGNED url on the
server-internal endpoint, so it expires within the hour and no browser outside the cluster can resolve it. That
is also why the web's "download analysis" link points at this route (through its BFF) instead of `analysisRef`.
Both power the analysis agent (`docs/architecture/analysis-studio.md`).

Optional `graders: GraderSpec[]` is the **run-time grading plan** — it replaces every case's default graders for
this batch only (the dataset stays pure data), and is persisted in `orchestration.graders` so restart-resume /
retry-failed / Temporal re-plans score exactly like the original submit (docs/architecture/eval-domain-model.md S5).
Optional `judges:[{id,version?}]` applies registered **Agent Judges** to each case's trace →
`judge:<id>` scores in the summary (control-plane, trace-based). Judging **streams per case**: each case is
judged as soon as it completes (bounded case-axis parallelism, deterministic per-case judge order), overlapping
the LLM-bound judge phase with dispatch; the `judges` step after dispatch is just the join of remaining tasks.
See `docs/judges.md` + `docs/architecture/streaming-case-pipeline.md`.

### Stopping a running scorecard (`POST /scorecards/:id/cancel`)
A user (or agent, via MCP) can **stop** a queued/running batch — `ScorecardService.cancel`. It reuses the
supersede machinery (a batch is a `running` aggregate with a live driver), so cancel and the CI-fired supersede
share one `stopInFlight` helper. The steps:
1. **Mark `cancelled`** — a new terminal `ScorecardStatus` (domain `ScorecardBatch.cancel`, guard `canCancel`). Like
   `superseded`, it is neither success nor failure, so baseline/diff/leaderboard/trend (which positively filter
   `status === "succeeded"`) ignore it. Marked FIRST so the track loop's abort branch settles it as cancelled
   (`settleAborted` preserves the pre-set aborted status) rather than reviving it. A terminal batch → `409` (the
   domain rejects the transition); another workspace's / a missing id → `404` (no existence leak).
2. **Stop the live work** (`stopInFlight`): cooperative `AbortSignal` so `runSuite` fires no more cases; cancel a
   Temporal-owned workflow; drop still-queued scheduler entries (`cancelQueued`) **and** self-hosted lease jobs
   (`cancelLeased`); force-kill the already-fired **managed** backend jobs (`killCase` → Nomad alloc-stop / K8s
   Job-delete) so a 601-case batch stops burning cluster compute.
3. **Free the runtime mid-case** — the self-hosted path: `cancelLeased` = `RunnerHub.requestCancel`, which rejects
   the parked/leased dispatch (the batch settles without waiting on the runner) and marks the lease
   `cancelRequested`; the runner learns of it on its next `heartbeat_job` reply (`{cancelled:true}`), aborts the
   in-flight run (an `AbortSignal` threaded runner-loop → `runLeasedJob` → `runCaseJob` → `runCase`), and disposes
   the compute — `docker rm -f` for a containerised case, or a process-group kill for host-native `LocalDriver` — so
   the work actually stops on the machine. (Latency = one heartbeat interval.) For a **service-topology** run the
   same `AbortSignal` threads into `ServiceTopologyBackend.dispatch` → the front-door driver: the in-flight
   submit/poll/stream/callback is aborted mid-flight (`CANCELLED`, freeing the held socket) instead of draining the
   topology run to completion, and the `dispatch` finally tears down the per-case browser (the shared warm services
   stay — they belong to other cases).

### Trace ingestion (`POST /scorecards/ingest`)
The "already-executed traces" path: produce a scorecard from **externally-run traces without dispatching a harness**.
The seam is the normalized `TraceEvent` (`@everdict/contracts`) — per-harness trace variance is absorbed at the **edge**
(the harness/SDK uploads already-normalized `TraceEvent[]`; the control plane only validates via `TraceEventSchema`).
`ScorecardService.ingest` resolves the referenced **dataset** (for `caseId`→task alignment + diff alignment),
wraps each uploaded trace as a `CaseResult`, **re-derives the trace-only graders** (`steps`/`cost`/`latency` →
`tool_calls`/`usd`/`span`, so ingested scorecards are diff-comparable to live runs), applies selected judges, and
stores a `ScorecardRecord`. Unknown `caseId`s are skipped; a bad `TraceEvent` is a `400` at the boundary. From
there judges/diff/dashboard reuse the same pipeline.

### Pull-mode trace ingestion (`POST /scorecards/ingest/pull`)
Two ways to get the trace in: **push** (upload `TraceEvent[]`, above) or **pull** (the control plane fetches it).
Pull is for harnesses that already emit to a tenant's own observability platform — instead of re-uploading, you
give the `source` (`kind` `otel`|`mlflow`|`langfuse`|`langsmith`|`phoenix` + `endpoint` + phoenix-only `project`)
and a `runs:[{caseId, runId}]` mapping. `ScorecardService.ingestPull`
builds a `TraceSource` (`packages/trace` `buildTraceSource`), fetches each `runId` (→ normalized `TraceEvent[]` via
the same `spansToTraceEvents` seam — per-harness span variance is absorbed by the adapter), then runs the **same**
`finishIngest` pipeline as push (re-derive `tool_calls`/`usd`/`span`, apply judges, store). So push and pull converge
on one scoring path; only the *acquisition* differs.

**Continuous evaluation over the OWNED store (N2).** The reserved source name `everdict` points the same
pull machinery at everdict's own trajectory store: `POST /scorecards/ingest/pull` with
`source: {name: "everdict"}` judges sealed trajectories by their run ids (read straight from the store — no
external platform, no re-upload, and no materialize duplicate: the evidence already lives there under its own
runId, kept as `externalIdByCase` provenance). A pull-mode **schedule** with `pull.source: "everdict"` judges a
rolling window of the store on every fire — "every hour, judge the last hour of production traces" with zero
platform integration. The name is reserved (a workspace trace source may not take it).

**Materialize-on-import (owned evidence).** Before anything grades or judges an ingested trace, `finishIngest`
seals it as **our copy** in the owned `TrajectoryStore` (`source: "import"`, keyed `ingest:<scorecardId>:<caseId>`)
and everything downstream — trace graders, judges, the record embed, export — reads the **sealed copy** (first write
wins). The scorecard's evidence lifetime detaches from the source platform at the pull: delete the trace there
afterwards and the evidence still opens. The external `runId` remains provenance on the record (the pull path's
attach/export coordinates). See `docs/architecture/native-observability.md`.

**Evaluate existing traces (no dataset / no harness run).** `dataset` and `harness` are **optional** on both ingest
paths. Omit them to score the traces *directly*: each trace becomes its own case (synthesized `EvalCase`, judges only —
no `expected`/ground-truth alignment) and the record is stamped with the reserved sentinel `dataset`/`harness`
(`TRACE_EVAL_REF` = `"_traces"`, `@everdict/contracts`) instead of a real registry ref. This keeps the NOT-NULL
dataset/harness columns populated with **no migration**, and consumers detect a trace evaluation by
`dataset.id === TRACE_EVAL_REF` — leaderboard/trend self-exclude it (they filter by a real datasetId), and the web
renders a "Trace evaluation" badge instead of a dataset/harness deep-link. This powers the web **"Evaluate traces"**
mode: pick a set of traces from a registered source and judge them. A named-source pull may also pass
`source.correlate` to override the pooled source's setting — the evaluate-traces flow forces `"id"` because it already
holds the platform's real trace ids (from `listTraces`), even when the source is normally used with `"tag"`
(`everdict.run_id`) correlation.

**Credentials never live in the request.** `source.authSecret` is the *name* of a workspace SecretStore entry; the
control plane resolves it server-side and injects it as the **verbatim `Authorization` header** on the fetch
(`secretsFor` + `buildTraceSource` deps). The secret value carries its own scheme — `Bearer <token>` for
OTel/Jaeger, `Basic <base64(user:pass)>` for MLflow (verified live against MLflow 3.11.1) — so no scheme is
hardcoded. No raw token crosses the API boundary — same discipline as runtimes (`docs/runtimes.md`). An upstream
non-2xx surfaces as the run going `failed` (`UpstreamError`); a `404` (trace not present yet) degrades to an empty
trace. MLflow uses the 3.x tracing REST (`GET /api/3.0/mlflow/traces/get`, OTLP-style spans).

### Trace sink (export judged detail to the team's observability platform)
The outbound mirror of pull-ingest. The workspace registers **named sinks**
(`GET/PUT /workspace/trace-sinks` + `DELETE /workspace/trace-sinks/:name` — kind
`mlflow|langfuse|langsmith|phoenix` + endpoint + `authSecretName` name-ref + per-kind `project`),
and each **harness opts in** by selecting one (`PUT /harnesses/:id/trace-sink`, member+). A
scorecard (live batch **and** ingest) whose harness selected a sink exports each case's
trace+scores to that platform right after judging, and the record carries the outcome in
**`export`** (`{sink, status: succeeded|partial|failed, url?, message?, cases[{caseId, externalId, url?,
error?}], exportedAt}`; Pg `sink_export` jsonb, mig 0048; detail-only — omitted from `list` like `steps`).
Export failure never fails the scorecard — the steps timeline gains an `export` entry and the detail page
shows status + deep links; `error.phase` is never set by export. **Attach-back (flow ②):** a pull-ingest
whose `source.kind` matches the sink kind attaches scores to the **original** trace ids (from the request's
`runs` mapping) instead of duplicating traces. Design SSOT: `docs/architecture/trace-sink.md`.

All workspace-scoped (other-workspace `get` → `404`/`NOT_FOUND`), one service core, one auth core. See
`docs/api.md`, `docs/mcp.md`, `docs/web.md`, `docs/datasets.md`, `docs/suites.md`.

## Web (`apps/web`)
- **Scorecards `/dashboard/scorecards`** — runs list (dataset@v → harness@v, status, per-metric summary chips).
- **Detail `/dashboard/scorecards/[id]`** — status, meta, per-metric **stat cards** (mean + pass-rate), per-case
  scores, error.
- **Create `/dashboard/scorecards/new`** (`widgets/scorecard-create`) — one entry, a **mode switch** for the two ways
  to make a scorecard (judging is common; only where the traces come from differs):
  - **Run harness** — pick **harness × dataset × judge(s)**: dataset + harness comboboxes (with a version picker each)
    and an optional **judge multi-select** (a combobox that appends registered Agent Judges as removable chips, each at
    `latest`) → `runScorecardAction` → `POST /scorecards` `{dataset, harness, judges?}`. The selected judges score each
    case's trace, so the detail page's per-metric stat cards gain a `judge:<id>` metric (mean + pass-rate) alongside the
    dataset's own graders. No judges picked = the dataset's graders only.
  - **Evaluate traces** — no dataset, no harness run: pick a registered observability trace source, filter by a time
    window (`Any`/`24h`/`Yesterday`/`7d`/`30d` → `since`/`until`), **multi-select** the traces to evaluate (the shared
    `TraceBrowser` in selection mode), and pick judges → `evaluateTracesAction` → `POST /scorecards/ingest/pull` with
    `dataset`/`harness` omitted (the trace-eval sentinel) and `source:{name, correlate:"id"}`.
  Role-gated off `/me` (`scorecards:run` = member+).
- **Compare `/dashboard/scorecards/compare?baseline=&candidate=`** — pick two succeeded scorecards → per-metric
  mean Δ table + **regressions (pass→fail) / improvements (fail→pass)** via `diffScorecards`. This is the
  baseline-vs-candidate payoff. `scorecards:read`.
- **Ingest `/dashboard/scorecards/ingest`** — a push|pull mode toggle. **push**: upload `TraceEvent[]` →
  `POST /scorecards/ingest`. **pull**: pick a `source` (OTel/MLflow endpoint + optional auth-secret name) + a
  `runs:[{caseId, runId}]` mapping → `POST /scorecards/ingest/pull`. Both add dataset + harness label + judges.
  `scorecards:run` (member+).


## Cost/time preflight + running ETA

`GET /scorecards/estimate?dataset&harness[&cases][&concurrency]` (+ MCP `estimate_scorecard`) answers "what
will this batch cost and how long will it run" from HISTORY: per-case usd/duration medians over the last few
succeeded batches of the same dataset×harness, projected to `{usd, wallSeconds}` at the given parallelism.
Honest when there is no history (`basis.samples: 0`, no estimate) — usd comes from trace-derived usage, so
non-metered workspaces see a 0 median rather than fiction. A RUNNING batch's `GET /scorecards/:id` carries a
derived `etaSeconds` (its own finished children's median × remaining waves) once the first child lands.
Live: 19 historical samples projected a 601-case batch at concurrency 32 to 551s; a mid-run sleep-25 batch
read `etaSeconds: 27` with one wave remaining.
