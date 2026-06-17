---
paths: "packages/trace/**"
---
# Trace rules (push)

Pull a harness's trace from OTel/MLflow and normalize to `TraceEvent`. See docs/service-harness.md.

- Each source (`OtelTraceSource` / `MlflowTraceSource`) parses its raw format → a normalized `Span[]`, then the
  shared `spansToTraceEvents` maps to `TraceEvent` (OTel GenAI semantic conventions; attr keys are configurable).
- Keep parsing pure/deterministic (unit-testable with sample span JSON); only `fetch()` does I/O.
