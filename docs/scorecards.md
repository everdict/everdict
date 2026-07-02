# Scorecards (batch eval: dataset × harness → aggregated result)

A **scorecard run** evaluates a whole **dataset** (N cases) against one `harness@version` and aggregates the
per-case results into a `Scorecard` + a per-metric `summary`. It's the eval payoff — the second step of the
pipeline and the input to baseline comparison (next increment):

```
Dataset → [scorecard run] → trace → agent-judge → scorecard → dashboard / baseline-compare
```

## How it works (`apps/api` `ScorecardService`)
1. Resolve the **dataset** (`DatasetRegistry`, owner-first/`_shared` fallback) → its cases. Missing → `404`.
2. Resolve the **harness version** (`latest → concrete`) via the registry; embed the `HarnessSpec` for
   declarative harnesses (builtins fall back to id). The record stores the **resolved** `harness@version`.
3. Build a `Suite` on the fly (`{ id: dataset.id, harness: { id }, cases }`) and run it with `@assay/suite`'s
   `runSuite` over the **same dispatcher** single runs use — each case becomes one job (tenant + budget
   admit/settle per case, concurrency-limited). The request's optional **`concurrency`** (1–64) sets how many
   cases dispatch at once (`runSuite` fan-out); omitted ⇒ service default (4). For a **self-hosted** runtime
   the parked jobs only run as fast as the runner leases them — match it with `assay runner --max-concurrent N`
   (effective case-level parallel = `min(concurrency, runner workers)`).
4. Aggregate with `summarizeScorecard` → store `{ status, summary, scorecard }`.

**Child runs (run = the primitive; scorecard = run × N).** Each case is dispatched through the **same
`executeCase` lifecycle** a single `POST /runs` uses (repo-token → dispatch → self-hosted-aware settle), and
— when a `runStore` is wired — each case also becomes an addressable child `RunRecord`
(`parentScorecardId` = this scorecard, `trigger: "scorecard"`, full trace/usage/provenance). The scorecard
records their ids in `runIds`. Child runs are **hidden from the default run/activity list**
(`RunStore.list` filters `parentScorecardId IS NULL`); fetch a batch's children with `list(tenant, {scorecardId})`.
The heavy per-case `scorecard` results are still embedded too (dual: embed + reference). See
`docs/architecture/run-as-primitive.md`.

Runs are **async**: submit returns a `queued` record; poll until terminal. Normal eval failures produce
`CaseResult`s (the batch still succeeds); only infra/budget errors fail the whole run.

**Failure visibility** (diagnose "어떤 구간에서 어떻게"): a per-case dispatch failure is isolated to a failed
`CaseResult` carrying `trace:[{kind:"error",message}]` + a `pass:false` score whose **`detail` = the reason**
(so the web/CLI shows *why* per case). A pipeline-level failure tags the record's `error.phase`
(`dispatch | judges | metrics | offload | persist`) so you see *which stage* broke, and the **partial
`scorecard`** (case results gathered before the failing stage) is persisted on the failed record too.

**Progress (steps timeline)** — not a percentage; the *process*. The run appends `ScorecardRecord.steps[]`
(`{ts, phase, status, message, caseId?}`) and **persists incrementally**: dispatch-started, one step **per case
as it completes** (`onResult` from `runSuite` → `caseId → PASS/FAIL · reason`), judges/metrics start+done, then
persist. The detail page renders this as a timeline and **auto-refreshes** (`router.refresh()`) while the run is
`queued`/`running`. `steps` is heavy detail → returned by `get`, **omitted from `list`** (like `scorecard`);
Pg column `steps jsonb` (migration `0026`).

## Storage (`@assay/db`)
`ScorecardStore` (`InMemoryScorecardStore` / `PgScorecardStore`), mirror of `RunStore`. `ScorecardRecord` =
`{ id, tenant, dataset:{id,version}, harness:{id,version}, status, summary?, scorecard?, error?, …}`. **`list`
omits the heavy `scorecard`** (traces) — only `summary` — so the list is cheap; `get` returns the full record.
Migration: `packages/db/migrations/0006_create_scorecards.sql`.

## BFF ↔ MCP parity
| HTTP route | MCP tool | Action |
|---|---|---|
| `POST /scorecards` `{dataset, harness, judges?, runtime?, concurrency?}` → 202 | `run_scorecard` | `scorecards:run` (member+) |
| `POST /scorecards/ingest` `{dataset, harness, traces[], judges?}` → 202 | `ingest_scorecard` | `scorecards:run` (member+) |
| `POST /scorecards/ingest/pull` `{dataset, harness, source{kind,endpoint,authSecret?}, runs[], judges?}` → 202 | `pull_scorecard` | `scorecards:run` (member+) |
| `GET /scorecards` (summary only) | `list_scorecards` | `scorecards:read` (viewer+) |
| `GET /scorecards/:id` (full) | `get_scorecard` | `scorecards:read` |
| `GET /scorecards/diff?baseline=&candidate=` | `diff_scorecards` | `scorecards:read` |

Optional `judges:[{id,version?}]` applies registered **Agent Judges** to each case's trace after the run →
`judge:<id>` scores in the summary (control-plane, trace-based). See `docs/judges.md`.

### Trace ingestion (`POST /scorecards/ingest`)
The "이미 수행한 트레이스" path: produce a scorecard from **externally-run traces without dispatching a harness**.
The seam is the normalized `TraceEvent` (`@assay/core`) — per-harness trace variance is absorbed at the **edge**
(the harness/SDK uploads already-normalized `TraceEvent[]`; the control plane only validates via `TraceEventSchema`).
`ScorecardService.ingest` resolves the referenced **dataset** (for `caseId`→task alignment + diff alignment),
wraps each uploaded trace as a `CaseResult`, **re-derives the trace-only graders** (`steps`/`cost`/`latency` →
`tool_calls`/`usd`/`span`, so ingested scorecards are diff-comparable to live runs), applies selected judges, and
stores a `ScorecardRecord`. Unknown `caseId`s are skipped; a bad `TraceEvent` is a `400` at the boundary. From
there judges/diff/dashboard reuse the same pipeline.

### Pull-mode trace ingestion (`POST /scorecards/ingest/pull`)
Two ways to get the trace in: **push** (upload `TraceEvent[]`, above) or **pull** (the control plane fetches it).
Pull is for harnesses that already emit to a tenant's own **OTel/MLflow** — instead of re-uploading, you give the
`source` (`kind` `otel`|`mlflow` + `endpoint`) and a `runs:[{caseId, runId}]` mapping. `ScorecardService.ingestPull`
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

All workspace-scoped (other-workspace `get` → `404`/`NOT_FOUND`), one service core, one auth core. See
`docs/api.md`, `docs/mcp.md`, `docs/web.md`, `docs/datasets.md`, `docs/suites.md`.

## Web (`apps/web`)
- **스코어카드 `/dashboard/scorecards`** — runs list (dataset@v → harness@v, status, per-metric summary chips).
- **상세 `/dashboard/scorecards/[id]`** — status, meta, per-metric **stat cards** (mean + pass-rate), per-case
  scores, error.
- **실행 `/dashboard/scorecards/new`** — pick dataset + harness (datalist) + optional judges → `runScorecardAction`
  → `POST /scorecards`. Role-gated off `/me` (`scorecards:run` = member+).
- **비교 `/dashboard/scorecards/compare?baseline=&candidate=`** — pick two succeeded scorecards → per-metric
  mean Δ table + **regressions (pass→fail) / improvements (fail→pass)** via `diffScorecards`. This is the
  baseline-vs-candidate payoff. `scorecards:read`.
- **인제스트 `/dashboard/scorecards/ingest`** — a push|pull mode toggle. **push**: upload `TraceEvent[]` →
  `POST /scorecards/ingest`. **pull**: pick a `source` (OTel/MLflow endpoint + optional auth-secret name) + a
  `runs:[{caseId, runId}]` mapping → `POST /scorecards/ingest/pull`. Both add dataset + harness label + judges.
  `scorecards:run` (member+).
