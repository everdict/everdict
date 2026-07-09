# Trace sink — export judged results to the team's observability platform

> **Status:** design (S0) → implementation. SSOT for the **outbound** half of the eval pipeline:
> after Everdict judges a scorecard's traces, the detailed per-case results are **exported to the
> tenant's own observability platform** (MLflow / Langfuse / LangSmith / Phoenix), and the
> scorecard becomes the **summary + deep links** surface. Mirror of the inbound `TraceSource`
> (`docs/scorecards.md` pull-ingest).

## Why

Teams already run an observability stack (MLflow, Langfuse, LangSmith, Phoenix) as their data
lake for LLM traces. Two evaluation flows converge on it:

1. **Live batch (flow ①)** — Everdict runs the harness over a dataset (`POST /scorecards`), produces
   traces, judges them. The *detailed* judged results (trace + scores) belong in the team's
   platform, next to everything else they observe; the Everdict scorecard shows the aggregate and
   links out.
2. **Ingest (flow ②)** — traces already exist in the team's platform (produced in prod). Everdict
   pulls them (`POST /scorecards/ingest/pull`), judges them — and the verdicts should land **back
   on the original traces** (as assessments/scores/feedback/annotations), not in a copy.

Both flows share the same back half: *judge → deliver detail to the team's platform → scorecard =
summary + links*. What was missing is the delivery: `packages/trace` was inbound-only
(`TraceSource`). This design adds the outbound mirror — **`TraceSink`** — plus the workspace
integration that configures it and the pipeline step that drives it.

## Decisions (locked)

- **Multiple named sinks per workspace, selected per harness.** Sinks are registered as a
  workspace-scoped integration (`WorkspaceSettings.traceSinks[]`, name-keyed upsert,
  `settings:write`) — a team runs more than one observability platform. **Which sink a scorecard
  exports to is a per-harness choice** (`WorkspaceSettings.traceSinkByHarness`:
  harness id → sink name, `PUT /harnesses/:id/trace-sink`, `harnesses:register` = member+;
  no selection = no export, opt-in). Removing a sink also clears assignments pointing at it
  (no dangling refs). Reads are `harnesses:read` (viewer+ — the harness detail shows the
  selection; views carry name-refs only). A per-scorecard override remains a non-goal.
- **Two modes, decided per case:**
  - **create** (flow ①): the trace was born in Everdict → create the trace in the platform, then
    attach the scores. Used by live batch and push-ingest.
  - **attach** (flow ②): the trace already lives in the platform → attach scores to the existing
    trace id, never duplicate it. Used by pull-ingest **when the pull source kind matches the sink
    kind** (today: mlflow→mlflow); otherwise falls back to create.
- **Export failure never fails the scorecard.** The scorecard record carries an `export` outcome
  (`succeeded | partial | failed` + message + per-case results); status/summary/diff/leaderboard
  are untouched. Same isolation discipline as notifications — but *not* fire-and-forget: the
  outcome is recorded and shown.
- **Scores exported = all scores** (graders + `judge:<id>`), mapped to the platform's native
  score/feedback/assessment concept. Score name = `Score.metric`.
- **Credentials are SecretStore name-refs**, resolved at point of use (`authSecretName`), never
  stored in settings, never returned by a view. The secret **value** is what the platform's auth
  header expects (see per-platform table); the adapter owns the header *name*.
- **Match the real upstream API** (trace rule): every adapter targets the platform's documented
  REST surface; where a platform cannot support a mode (e.g. attach-by-trace-id unsupported), the
  adapter reports an honest per-case error — no silent skip.

## Data model

### `WorkspaceSettings.traceSinks` + `traceSinkByHarness` (packages/db, JSONB — additive, no migration)

```ts
traceSinks: z.array(z.object({
  name: z.string().min(1),                  // reference key — harness assignments point at this
  kind: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]),
  endpoint: z.string().url(),               // API base URL of the tenant's platform
  authSecretName: z.string().min(1).optional(), // SecretStore key — auth header VALUE (optional: unauthenticated dev servers)
  project: z.string().min(1).optional(),    // per-kind: mlflow experiment_id · langsmith project(session_name) · phoenix project · langfuse projectId (links)
  webUrl: z.string().url().optional(),      // UI deep-link base when it differs from endpoint (e.g. LangSmith api vs smith.langchain.com)
})).optional(),
traceSinkByHarness: z.record(z.string()).optional() // harness id → sink name; no entry = no export (opt-in)
```

`exportScorecard` resolves the sink from `ctx.harness`'s id via the assignment map; the recorded
outcome carries the sink `name` (which of the workspace's sinks it was).

### `ScorecardRecord.export` (packages/db — new `sink_export` jsonb column, migration 0048)

```ts
export: z.object({
  sink: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]),
  status: z.enum(["succeeded", "partial", "failed"]),
  url: z.string().optional(),        // top-level deep link (experiment / project)
  message: z.string().optional(),    // failure/partial reason
  exportedAt: z.string(),
  cases: z.array(z.object({
    caseId: z.string(),
    externalId: z.string().optional(), // platform trace/run id (created or attached-to)
    url: z.string().optional(),        // per-case trace deep link
    error: z.string().optional(),      // per-case failure (isolated — other cases still export)
  })).optional(),
}).optional()
```

Heavy-ish detail → returned by `get`, **omitted from `list`** (like `steps`/`runIds`). This also
(finally) **persists the external trace id per case** for pull-ingest — the `runs[{caseId,runId}]`
mapping used to vanish after ingest.

## `TraceSink` contract (packages/trace) — outbound mirror of `TraceSource`

```ts
export interface TraceSinkScore { name: string; value: number; pass?: boolean; comment?: string }
export interface TraceSinkCase {
  caseId: string;
  trace: TraceEvent[];
  scores: TraceSinkScore[];
  externalId?: string;   // present → attach mode; absent → create mode
}
export interface TraceSinkContext { scorecardId: string; dataset: string; harness: string }
export interface TraceSinkCaseResult { caseId: string; externalId?: string; url?: string; error?: string }
export interface TraceSinkResult { url?: string; cases: TraceSinkCaseResult[] }

export interface TraceSink {
  // The whole case array at once — the adapter picks batch/loop internally (Langfuse = 1 batch-ingestion call).
  export(ctx: TraceSinkContext, cases: TraceSinkCase[]): Promise<TraceSinkResult>;
}

export interface TraceSinkConfig {
  kind: "mlflow" | "langfuse" | "langsmith" | "phoenix";
  endpoint: string;
  auth?: string;          // resolved secret VALUE — adapter places it in its platform's auth header
  project?: string;
  webUrl?: string;
  fetchImpl?: typeof fetch;
}
export function buildTraceSink(cfg: TraceSinkConfig): TraceSink;
```

Same discipline as sources: **payload building is pure** (unit-testable per adapter), only the
HTTP call does I/O (`fetchImpl` injected in tests); wholesale upstream failure (auth, connect)
throws `UpstreamError`; **per-case** failures are isolated into `cases[].error` so one bad case
doesn't sink the batch.

## Per-platform adapters

Verified against official docs / OpenAPI / proto / source (2026-07):

| kind | auth header (secret value) | create (flow ①) | attach (flow ②) | deep link |
|---|---|---|---|---|
| `mlflow` | `Authorization` verbatim (`Basic …`; OSS default is no auth) | `POST /api/3.0/mlflow/traces` (StartTraceV3, `trace_info` only — client-supplied `tr-<32hex>` id, `trace_location.mlflow_experiment.experiment_id` = `project`; **the `spans` array is ignored by the server**) **+ spans via OTLP/JSON `POST /v1/traces`** (`x-mlflow-experiment-id` header; attrs emitted in the OTel GenAI conventions our own `spansToTraceEvents` reads → pull round-trips). OTLP/JSON needs server ≥3.12 → span upload is **best-effort**: on older servers the case still succeeds with trace-info+assessments (live-verified: 3.11 degrades — its `traces/get` 500s "Trace data not stored" — 3.14 round-trips). `project` required for create; per-case honest error without it. | `POST /api/3.0/mlflow/traces/{trace_id}/assessments` — field is **`assessment_name`** (not `name`); `source.source_type` `LLM_JUDGE`(judge:*) / `CODE` + `source_id` required; `rationale` top-level; `feedback.value` = score | `{web}/#/experiments/{project}/traces?selectedEvaluationId={id}` (≥3.6 UI) |
| `langfuse` | `Authorization: Basic base64(pk:sk)` verbatim | `POST /api/public/ingestion` — batch (`{batch:[{id,type,timestamp,body}]}`; envelope `id` = dedup key): `trace-create` + `generation-create` (**`usageDetails`/`costDetails`**, not deprecated `usage`) + `span-create` (tool calls) + `score-create`. Response **207**; `errors[].id` → event → case (partial isolation). 3.5 MB batch cap → events are **chunked** (~3 MB serialized, order-preserving) across multiple POSTs. | `score-create` events with `traceId` = existing id (no trace-create) | `{web}/project/{project}/traces/{id}`; without project: `{web}/trace/{id}` server-side redirect |
| `langsmith` | **`x-api-key`** (raw key — not Authorization) | `POST /runs` (bare path, like the SDK) per case — client uuid, root run `trace_id` = own id, one-shot with `outputs`/`end_time`, `session_name` = `project` (auto-creates) | `POST /feedback` (`run_id`, `key`, `score`, `comment`, `feedback_source.type` `model`(judge)/`api`). Run ingest is async (202) → one 404-retry | per-case: `GET /runs/{id}`.`app_path` joined onto the web base (best-effort, one 404-retry; no link if unavailable — never hand-assembled from uuids) |
| `phoenix` | `Authorization: Bearer …` verbatim | `POST /v1/projects/{project}/spans` (**plain-JSON endpoint, ≥10.12**) — `/v1/traces` is protobuf-only OTLP, NOT used. OTel hex ids (trace 32 / span 16), root `CHAIN` + `LLM`/`TOOL` child spans, per-case batch (all-or-nothing per case). `project` required for create. | `POST /v1/trace_annotations` (`annotator_kind` `LLM`/`CODE`, `result{score,label,explanation}`); enqueued (`sync=false`) to avoid 404 on just-queued spans | `{web}/redirects/traces/{hex}` (id-only redirect, 2025+ servers) |

The **TraceEvent → platform-native** mapping is the inverse of `spansToTraceEvents`: `llm_call` →
generation/LLM span (model, tokens, cost, latency), `tool_call`+`tool_result` → tool span (ok →
level/status), first user / last assistant `message` → input/output previews. Payload builders are
pure and unit-tested per adapter (`packages/trace/src/*-sink.ts`).

## Pipeline wiring (apps/api)

One service core, `TraceSinkService` (`apps/api/src/integrations/trace-sink-service.ts`):

- **Settings CRUD** — `get/set/clear(workspace)`, mirror of `MattermostService` (view = name-refs
  only, safe to expose).
- **Export core** — `exportStream(tenant, ctx, attach?)` → `{push, settle}` (**streaming, D5** —
  `docs/architecture/streaming-case-pipeline.md`): setup once at creation (read settings → no sink
  configured = no-op (undefined) → resolve `authSecretName` via `secretsFor` → `buildTraceSink`);
  `push(case)` fires a bounded per-case `sink.export(ctx, [case])` (scores → `{name: metric, value,
  pass, comment: detail}`); `settle()` joins and aggregates `succeeded | partial | failed` into the
  same record `export` payload. Never throws (per-case errors isolate into `cases[].error`; a
  wholesale failure promotes the first case error to the top-level message).
  `exportScorecard(tenant, ctx, results, attach?)` = push-all + settle over the same core (batch
  consumption for ingest + fallback).

Call sites (both share it — same seam as `ScoringService`):

- **Live batch** — `ScorecardService.track()` **streams**: each case is pushed the moment its judging
  completes (`JudgeStream.push` returns the per-case completion promise; the orchestrator chains
  `judged.then(push)`), so cases appear on the team's platform while the batch runs and a mid-batch
  death keeps what already exported. After offload, `settle()` joins and the outcome lands in the same
  terminal `store.update`; a superseded batch records a partial outcome for already-exported cases.
  Steps timeline gains an `export` phase (`ok/failed`) so the detail page shows the stage. `error.phase` is
  never set by export.
- **Ingest (push + pull)** — `finishIngest()`: same position. The pull path passes
  `externalIdByCase` (from the request's `runs` mapping) **when `source.kind === sink.kind`** →
  attach mode; push and kind-mismatched pull export in create mode.

## AuthZ / surfaces (BFF↔MCP parity)

| HTTP route | MCP tool | Action |
|---|---|---|
| `GET /workspace/trace-sinks` → `{sinks, assignments}` | `list_workspace_trace_sinks` | `harnesses:read` (viewer+) |
| `PUT /workspace/trace-sinks` (name upsert) | `set_workspace_trace_sink` | `settings:write` (admin) |
| `DELETE /workspace/trace-sinks/:name` | `remove_workspace_trace_sink` | `settings:write` (admin) |
| `PUT /harnesses/:id/trace-sink` `{sink\|null}` | `assign_harness_trace_sink` | `harnesses:register` (member+) |

The export outcome rides the existing scorecard surfaces (`GET /scorecards/:id` /
`get_scorecard`) — no new read route.

## Web (apps/web)

- **Settings → Integrations**: the integrations tab is a **summary list** (row per integration:
  connected/registered-count badge + management entry) — clicking Trace sinks opens the sink list manager
  (name-keyed add/edit/remove; kind select + endpoint + `authSecretName` SecretPicker + per-kind
  project + webUrl; InfoTip guide). **Harness detail** gains a sink-select selector
  (`HarnessSinkSelect`, member+) — this is where export is turned on per harness.
- **Scorecard detail**: an export strip — sink kind badge + status + top-level link + per-case
  external links in the cases table; failure shows the recorded message. No section when the
  record has no `export` (hide-empty convention).

## Slices

- **S0 — this doc.**
- **S1 — `packages/trace` sink core:** `TraceSink` contract + `buildTraceSink` + 4 adapters +
  shared `TraceEvent→OTLP` mapping; pure builders unit-tested per adapter (injected fetch),
  Korean BDD.
- **S2 — workspace integration:** `WorkspaceSettings.traceSinks` + `TraceSinkService` (CRUD) +
  routes + MCP tools + tests (server inject + MCP client).
- **S3 — pipeline export:** `ScorecardRecord.export` (+ mig 0048 `sink_export jsonb`, additive) +
  `TraceSinkService.exportScorecard` + `track()`/`finishIngest()` wiring (+ pull attach-mode) +
  tests (export recorded; failure isolated; attach receives external ids).
- **S4 — web:** settings card + scorecard-detail export strip + BFF client fns.
- **F1 — pull sources (SHIPPED):** `TraceSourceConfig.kind` extended to
  `otel|mlflow|langfuse|langsmith|phoenix` — flow ②'s round-trip works on all four sink platforms.
  Read APIs (verified against OpenAPI/source): Langfuse `GET /api/public/traces/{id}`
  (observations inline, `usageDetails` over deprecated `usage`, type enum is 10-wide — don't
  hardcode 3); LangSmith `POST /runs/query {trace}` + `cursors.next` loop (**v1**, not v2 which
  requires `project_ids`+1-day window; `total_cost` is a **decimal string**); Phoenix
  `GET /v1/projects/{p}/spans?trace_id=` (filter needs server ≥13.9.0; read-side `attributes` are
  **nested**, create-side flat — both normalized). New config knobs: `auth` (value; adapter owns
  the header name — langsmith `x-api-key`) + `project` (phoenix path requirement);
  `headers.authorization` is inherited as `auth` for the existing pull path.
- **F5 — live e2e (PASS, 2026-07-06):** `scripts/live/trace-sink-mlflow.mjs` — real MLflow
  3.11.1 (infra stack, Basic auth): create + attach verified by assessment read-back, span upload
  degrades (documented; `traces/get` 500s span-less traces); MLflow 3.14.0 (sqlite): full span
  round-trip (sink OTLP/JSON → source → 4 normalized events, model/tokens intact).
- **Remaining follow-ups:** live e2e for Langfuse/LangSmith/Phoenix (needs real accounts/servers);
  per-scorecard sink override if demanded.

## Non-goals

- Streaming/incremental export (per-case as it completes) — v1 exports once at finalize.
- Everdict as a *proxy* for the platform UI (we link out; we don't re-render their trace viewer).
- Multi-sink fan-out (one workspace = one sink).

## Live verification status

- **MLflow** — create/attach + spans round-trip: PASS vs 3.11 (span degrade) and 3.14 (`scripts/live/trace-sink-mlflow.mjs`).
- **Phoenix** — create (spans + annotations) / attach (annotations only, trace count stable) / source round-trip:
  PASS vs a real `arizephoenix/phoenix` (`scripts/live/trace-sink-phoenix.mjs`).
- **Langfuse v2** — create (ingestion batch) / attach (score events only, trace count stable) / source round-trip:
  PASS vs a real `langfuse/langfuse:2` + postgres, headless-init keys (`scripts/live/trace-sink-langfuse.mjs`).
- **LangSmith** — cloud-only (no self-hostable OSS server, needs an account API key): adapter is unit-tested
  against the documented API shape; live verification pending a key.

## Per-scorecard override

`POST /scorecards` (+ MCP `run_scorecard` `trace_sink`) accepts `traceSink`: the name of a configured workspace
sink — a one-shot override above the harness's own selection — or the literal `"none"` to suppress export for
that batch only. Submit validates the name against the workspace roster (400 on unknown; `"none"` always
allowed) and persists it on `orchestration.traceSink`, so resume/retry keep the same destination. Resolution
order inside `TraceSinkService.exportStream`: batch override → harness selection → no export.

