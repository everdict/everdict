---
paths: "packages/trace/**"
---
# Trace rules (push)

Pull a harness's trace from OTel/MLflow and normalize to `TraceEvent` (`TraceSource`), and export judged
results back out to the team's observability platform (`TraceSink` — the outbound mirror). See
docs/service-harness.md + docs/architecture/trace-sink.md.

- Each source (`OtelTraceSource` / `MlflowTraceSource`) parses its raw format → a normalized `Span[]`, then the
  shared `spansToTraceEvents` maps to `TraceEvent` (OTel GenAI semantic conventions; attr keys are configurable).
- Keep parsing pure/deterministic (unit-testable with sample span JSON); only `fetch()` does I/O. Inject `fetchImpl`
  for tests.
- **Credentials are injected, never embedded.** A source takes `headers?`; the caller resolves the value from the
  tenant SecretStore by name and passes it as the **verbatim `Authorization` header** — the scheme lives in the
  secret value (`Bearer …` for OTel/Jaeger, `Basic <base64>` for MLflow), NOT hardcoded. The source never reads
  secrets itself. Use the `buildTraceSource(cfg)` factory (kind/endpoint/headers) to build a source from config.
- **Source kinds are 5-wide**: `otel|mlflow` (headers path, above) + `langfuse|langsmith|phoenix` — the newer
  three take `auth` (the resolved value; the **adapter owns the header name** — langsmith is `x-api-key`, the
  others verbatim `Authorization`); the factory inherits `headers.authorization` as `auth` so the existing pull
  path needs no change. Phoenix additionally needs `project` (spans are only addressable via
  `GET /v1/projects/{p}/spans?trace_id=`, filter ≥13.9.0; read-side `attributes` come **nested** while create-side
  is flat-dotted — normalize both). LangSmith trace fetch is v1 `POST /runs/query {trace}` + `cursors.next` loop
  (v2 needs `project_ids` + defaults to a 1-day window — wrong tool); `total_cost` is a decimal **string**.
  Langfuse observations arrive inline (no cursor); prefer `usageDetails`/`costDetails` over deprecated `usage`.
- **Match the real upstream API, not a guess.** `MlflowTraceSource` hits MLflow 3.x `GET /api/3.0/mlflow/traces/get?trace_id=`
  and parses **OTLP-style spans** (`attributes` = `{key,value:{string_value|int_value|bool_value|kvlist_value…}}`
  array, snake_case — distinct from OTel's camelCase `stringValue`). Verified live against MLflow 3.11.1.
  `correlate:"tag"` resolves an assay `runId` via `POST /api/3.0/mlflow/traces/search` — `locations` is
  REQUIRED (`experimentIds`), the filter is `` tags.`assay.run_id` = '…' `` (backtick-quoted), and the agent-side
  tag write is `PATCH /api/3.0/mlflow/traces/{id}/tags`. Verified live against MLflow 3.14.0.
  `OtelTraceSource` `correlate:"tag"` uses the **Jaeger query API**: `GET /api/traces?service=…&tags=<JSON
  {"assay.run_id":…}>&limit=1` — `service` is REQUIRED (400 without), the `tags` filter matches
  **resource(process) tags**, and the search response embeds full spans (same `{data:[{spans}]}` parser, one
  request). OTLP-native backends (no search API) stay id-correlated. Verified live against Jaeger 1.62.0.
- Remap upstream failures to our error model: a non-2xx → `UpstreamError` (so a pull run fails honestly), EXCEPT
  `404` → `[]` (trace not present yet; service-harness path scores 0 events).
- **Sinks (`*-sink.ts`, `buildTraceSink`)** mirror the source discipline with three deltas: ① auth is a single
  resolved `auth` value and the **adapter owns the header name** (mlflow/langfuse/phoenix → verbatim
  `Authorization`; langsmith → `x-api-key`); ② per-case failures are isolated into `cases[].error` (only
  wholesale auth/connect failures throw `UpstreamError`) — the pipeline records the outcome on
  `ScorecardRecord.export`, never fails the scorecard; ③ each case is **create** (no `externalId` — build the
  trace, then attach scores) or **attach** (`externalId` — scores only, never duplicate the trace). Payload
  builders stay pure/injectable (`newId`/`now`/`fetchImpl`). Real-API facts pinned in adapters: MLflow
  assessments use `assessment_name` + `source_type`, StartTraceV3 **ignores `spans`** → spans go separately via
  OTLP/JSON `POST /v1/traces` + `x-mlflow-experiment-id` (server ≥3.12; **best-effort** — older servers degrade
  to trace-info+assessments, never a case failure; emit attrs in the OTel GenAI conventions `spansToTraceEvents`
  reads so pull round-trips); Langfuse ingestion is a 207 batch with `usageDetails` (not `usage`), **chunked**
  under the 3.5 MB cap; LangSmith `POST /runs` is async(202) → one 404-retry on feedback, per-case links come
  from `GET /runs/{id}`.`app_path` (never hand-assembled uuids); Phoenix JSON spans go to
  `/v1/projects/{p}/spans` (NOT `/v1/traces` — protobuf-only).
