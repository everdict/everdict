---
paths: "packages/trace/**"
---
# Trace rules (push)

Pull a harness's trace from OTel/MLflow and normalize to `TraceEvent`. See docs/service-harness.md.

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
