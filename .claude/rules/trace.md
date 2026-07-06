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
- **Match the real upstream API, not a guess.** `MlflowTraceSource` hits MLflow 3.x `GET /api/3.0/mlflow/traces/get?trace_id=`
  and parses **OTLP-style spans** (`attributes` = `{key,value:{string_value|int_value|bool_value|kvlist_value…}}`
  array, snake_case — distinct from OTel's camelCase `stringValue`). Verified live against MLflow 3.11.1.
- Remap upstream failures to our error model: a non-2xx → `UpstreamError` (so a pull run fails honestly), EXCEPT
  `404` → `[]` (trace not present yet; service-harness path scores 0 events).
- **Sinks (`*-sink.ts`, `buildTraceSink`)** mirror the source discipline with three deltas: ① auth is a single
  resolved `auth` value and the **adapter owns the header name** (mlflow/langfuse/phoenix → verbatim
  `Authorization`; langsmith → `x-api-key`); ② per-case failures are isolated into `cases[].error` (only
  wholesale auth/connect failures throw `UpstreamError`) — the pipeline records the outcome on
  `ScorecardRecord.export`, never fails the scorecard; ③ each case is **create** (no `externalId` — build the
  trace, then attach scores) or **attach** (`externalId` — scores only, never duplicate the trace). Payload
  builders stay pure/injectable (`newId`/`now`/`fetchImpl`). Real-API facts pinned in adapters: MLflow
  assessments use `assessment_name` + `source_type` and StartTraceV3 **ignores `spans`**; Langfuse ingestion is a
  207 batch with `usageDetails` (not `usage`); LangSmith `POST /runs` is async(202) → one 404-retry on feedback;
  Phoenix JSON spans go to `/v1/projects/{p}/spans` (NOT `/v1/traces` — protobuf-only).
