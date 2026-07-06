# Trace sink — export judged results to the team's observability platform

> **Status:** design (S0) → implementation. SSOT for the **outbound** half of the eval pipeline:
> after Assay judges a scorecard's traces, the detailed per-case results are **exported to the
> tenant's own observability platform** (MLflow / Langfuse / LangSmith / Phoenix), and the
> scorecard becomes the **summary + deep links** surface. Mirror of the inbound `TraceSource`
> (`docs/scorecards.md` pull-ingest).

## Why

Teams already run an observability stack (MLflow, Langfuse, LangSmith, Phoenix) as their data
lake for LLM traces. Two evaluation flows converge on it:

1. **Live batch (flow ①)** — Assay runs the harness over a dataset (`POST /scorecards`), produces
   traces, judges them. The *detailed* judged results (trace + scores) belong in the team's
   platform, next to everything else they observe; the Assay scorecard shows the aggregate and
   links out.
2. **Ingest (flow ②)** — traces already exist in the team's platform (produced in prod). Assay
   pulls them (`POST /scorecards/ingest/pull`), judges them — and the verdicts should land **back
   on the original traces** (as assessments/scores/feedback/annotations), not in a copy.

Both flows share the same back half: *judge → deliver detail to the team's platform → scorecard =
summary + links*. What was missing is the delivery: `packages/trace` was inbound-only
(`TraceSource`). This design adds the outbound mirror — **`TraceSink`** — plus the workspace
integration that configures it and the pipeline step that drives it.

## Decisions (locked)

- **One sink per workspace**, configured as a workspace-scoped integration
  (`WorkspaceSettings.traceSink`, `settings:write`) — same pattern as Mattermost / image registry.
  A per-scorecard override is a non-goal for v1 (the sink is team infra, not a per-run knob).
- **Two modes, decided per case:**
  - **create** (flow ①): the trace was born in Assay → create the trace in the platform, then
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

### `WorkspaceSettings.traceSink` (packages/db, JSONB — additive, no migration)

```ts
traceSink: z.object({
  kind: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]),
  endpoint: z.string().url(),               // API base URL of the tenant's platform
  authSecretName: z.string().min(1).optional(), // SecretStore key — auth header VALUE (optional: unauthenticated dev servers)
  project: z.string().min(1).optional(),    // per-kind: mlflow experiment_id · langsmith project(session_name) · phoenix project · langfuse projectId (links)
  webUrl: z.string().url().optional(),      // UI deep-link base when it differs from endpoint (e.g. LangSmith api vs smith.langchain.com)
}).nullable().optional()                    // DELETE clears with null (JSONB || can't drop keys)
```

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
  // 케이스 배열을 한 번에 — 어댑터가 내부에서 배치/루프를 선택(Langfuse 는 배치 ingestion 1콜).
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
| `mlflow` | `Authorization` verbatim (`Basic …`; OSS default is no auth) | `POST /api/3.0/mlflow/traces` (StartTraceV3, `trace_info` only — client-supplied `tr-<32hex>` id, `trace_location.mlflow_experiment.experiment_id` = `project`). **The `spans` array is ignored by the server**; span upload is a separate OTLP path (JSON only ≥3.12) → v1 exports trace-info (previews + metadata) + assessments, spans are a follow-up. `project` required for create; per-case honest error without it. | `POST /api/3.0/mlflow/traces/{trace_id}/assessments` — field is **`assessment_name`** (not `name`); `source.source_type` `LLM_JUDGE`(judge:*) / `CODE` + `source_id` required; `rationale` top-level; `feedback.value` = score | `{web}/#/experiments/{project}/traces?selectedEvaluationId={id}` (≥3.6 UI) |
| `langfuse` | `Authorization: Basic base64(pk:sk)` verbatim | `POST /api/public/ingestion` — one batch (`{batch:[{id,type,timestamp,body}]}`; envelope `id` = dedup key): `trace-create` + `generation-create` (**`usageDetails`/`costDetails`**, not deprecated `usage`) + `span-create` (tool calls) + `score-create`. Response **207**; `errors[].id` → event → case (partial isolation). 3.5 MB batch cap (splitting = follow-up). | `score-create` events with `traceId` = existing id (no trace-create) | `{web}/project/{project}/traces/{id}`; without project: `{web}/trace/{id}` server-side redirect |
| `langsmith` | **`x-api-key`** (raw key — not Authorization) | `POST /runs` (bare path, like the SDK) per case — client uuid, root run `trace_id` = own id, one-shot with `outputs`/`end_time`, `session_name` = `project` (auto-creates) | `POST /feedback` (`run_id`, `key`, `score`, `comment`, `feedback_source.type` `model`(judge)/`api`). Run ingest is async (202) → one 404-retry | per-case link needs tenant/project uuids → v1 links the web base only (follow-up: `GET /runs/{id}`.`app_path`) |
| `phoenix` | `Authorization: Bearer …` verbatim | `POST /v1/projects/{project}/spans` (**plain-JSON endpoint, ≥10.12**) — `/v1/traces` is protobuf-only OTLP, NOT used. OTel hex ids (trace 32 / span 16), root `CHAIN` + `LLM`/`TOOL` child spans, per-case batch (all-or-nothing per case). `project` required for create. | `POST /v1/trace_annotations` (`annotator_kind` `LLM`/`CODE`, `result{score,label,explanation}`); enqueued (`sync=false`) to avoid 404 on just-queued spans | `{web}/redirects/traces/{hex}` (id-only redirect, 2025+ servers) |

The **TraceEvent → platform-native** mapping is the inverse of `spansToTraceEvents`: `llm_call` →
generation/LLM span (model, tokens, cost, latency), `tool_call`+`tool_result` → tool span (ok →
level/status), first user / last assistant `message` → input/output previews. Payload builders are
pure and unit-tested per adapter (`packages/trace/src/*-sink.ts`).

## Pipeline wiring (apps/api)

One service core, `TraceSinkService` (`apps/api/src/trace-sink-service.ts`):

- **Settings CRUD** — `get/set/clear(workspace)`, mirror of `MattermostService` (view = name-refs
  only, safe to expose).
- **Export** — `exportScorecard(tenant, ctx, results, externalIdByCase?)`: read settings → no sink
  configured = no-op (undefined) → resolve `authSecretName` via `secretsFor` → `buildTraceSink` →
  map `CaseResult[]` to `TraceSinkCase[]` (scores → `{name: metric, value, pass, comment: detail}`)
  → `sink.export` → derive `succeeded | partial | failed` → return the record `export` payload.
  Never throws (catches → `{status: "failed", message}`).

Call sites (both share it — same seam as `ScoringService`):

- **Live batch** — `ScorecardService.track()`: after judges + offload, **before** the final
  persist; the outcome lands in the same terminal `store.update`. Steps timeline gains an
  `export` phase (`started → ok/failed`) so the detail page shows the stage. `error.phase` is
  never set by export.
- **Ingest (push + pull)** — `finishIngest()`: same position. The pull path passes
  `externalIdByCase` (from the request's `runs` mapping) **when `source.kind === sink.kind`** →
  attach mode; push and kind-mismatched pull export in create mode.

## AuthZ / surfaces (BFF↔MCP parity)

| HTTP route | MCP tool | Action |
|---|---|---|
| `GET /workspace/trace-sink` | `get_workspace_trace_sink` | `settings:read` |
| `PUT /workspace/trace-sink` | `set_workspace_trace_sink` | `settings:write` (admin) |
| `DELETE /workspace/trace-sink` | `remove_workspace_trace_sink` | `settings:write` (admin) |

The export outcome rides the existing scorecard surfaces (`GET /scorecards/:id` /
`get_scorecard`) — no new read route.

## Web (apps/web)

- **Settings → 통합**: "트레이스 싱크" card (Linear settings-list pattern) — kind select +
  endpoint + `authSecretName` (SecretPicker) + project + webUrl; guide text via InfoTip.
- **Scorecard detail**: an export strip — sink kind badge + status + top-level link + per-case
  external links in the cases table; failure shows the recorded message. No section when the
  record has no `export` (hide-empty convention).

## Slices

- **S0 — this doc.**
- **S1 — `packages/trace` sink core:** `TraceSink` contract + `buildTraceSink` + 4 adapters +
  shared `TraceEvent→OTLP` mapping; pure builders unit-tested per adapter (injected fetch),
  Korean BDD.
- **S2 — workspace integration:** `WorkspaceSettings.traceSink` + `TraceSinkService` (CRUD) +
  routes + MCP tools + tests (server inject + MCP client).
- **S3 — pipeline export:** `ScorecardRecord.export` (+ mig 0048 `sink_export jsonb`, additive) +
  `TraceSinkService.exportScorecard` + `track()`/`finishIngest()` wiring (+ pull attach-mode) +
  tests (export recorded; failure isolated; attach receives external ids).
- **S4 — web:** settings card + scorecard-detail export strip + BFF client fns.
- **Follow-ups:** Langfuse/LangSmith/Phoenix as **pull sources** (`TraceSourceConfig.kind`
  extension — completes flow ② round-trip beyond MLflow); live e2e against a real MLflow
  (`scripts/live/`); per-scorecard sink override if demanded.

## Non-goals

- Streaming/incremental export (per-case as it completes) — v1 exports once at finalize.
- Assay as a *proxy* for the platform UI (we link out; we don't re-render their trace viewer).
- Multi-sink fan-out (one workspace = one sink).
