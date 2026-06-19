---
paths: "packages/trace/**"
---
# Trace rules (push)

Pull a harness's trace from OTel/MLflow and normalize to `TraceEvent`. See docs/service-harness.md.

- Each source (`OtelTraceSource` / `MlflowTraceSource`) parses its raw format → a normalized `Span[]`, then the
  shared `spansToTraceEvents` maps to `TraceEvent` (OTel GenAI semantic conventions; attr keys are configurable).
- Keep parsing pure/deterministic (unit-testable with sample span JSON); only `fetch()` does I/O. Inject `fetchImpl`
  for tests.
- **Credentials are injected, never embedded.** A source takes `headers?` (e.g. `Authorization: Bearer …`); the
  caller resolves the token from the tenant SecretStore by name — the source never reads secrets itself. Use the
  `buildTraceSource(cfg)` factory (kind/endpoint/headers) to construct a source from config (pull-mode ingest).
- Remap upstream failures to our error model: `OtelTraceSource` throws `UpstreamError` on a non-2xx (so a pull run
  fails honestly); `MlflowTraceSource` degrades a missing trace to `[]` (graders score 0 events).
