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
3. Build a `Suite` on the fly (`{ id: dataset.id, harness: { id }, cases }`) and run it with `@everdict/suite`'s
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
(`RunStore.list` filters `parentScorecardId IS NULL`); fetch a batch's children with `list(tenant, {scorecardId})`
(`GET /runs?scorecardId=` / MCP `list_runs scorecard_id`), which powers the scorecard detail's case→run drill-down.
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

## BFF ↔ MCP parity
| HTTP route | MCP tool | Action |
|---|---|---|
| `POST /scorecards` `{dataset, harness, judges?, runtime?, concurrency?, cases?{ids,tags,limit}}` → 202 | `run_scorecard` | `scorecards:run` (member+) |
| `POST /scorecards/ingest` `{dataset, harness, traces[], judges?}` → 202 | `ingest_scorecard` | `scorecards:run` (member+) |
| `POST /scorecards/ingest/pull` `{dataset, harness, source{kind,endpoint,authSecret?}, runs[], judges?}` → 202 | `pull_scorecard` | `scorecards:run` (member+) |
| `GET /scorecards` (summary only) | `list_scorecards` | `scorecards:read` (viewer+) |
| `GET /scorecards/:id` (full) | `get_scorecard` | `scorecards:read` |
| `GET /scorecards/diff?baseline=&candidate=` | `diff_scorecards` | `scorecards:read` |

Optional `judges:[{id,version?}]` applies registered **Agent Judges** to each case's trace →
`judge:<id>` scores in the summary (control-plane, trace-based). Judging **streams per case**: each case is
judged as soon as it completes (bounded case-axis parallelism, deterministic per-case judge order), overlapping
the LLM-bound judge phase with dispatch; the `judges` step after dispatch is just the join of remaining tasks.
See `docs/judges.md` + `docs/architecture/streaming-case-pipeline.md`.

### Trace ingestion (`POST /scorecards/ingest`)
The "already-executed traces" path: produce a scorecard from **externally-run traces without dispatching a harness**.
The seam is the normalized `TraceEvent` (`@everdict/core`) — per-harness trace variance is absorbed at the **edge**
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
- **Run `/dashboard/scorecards/new`** — pick dataset + harness (datalist) + optional judges → `runScorecardAction`
  → `POST /scorecards`. Role-gated off `/me` (`scorecards:run` = member+).
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
