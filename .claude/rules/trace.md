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
  `correlate:"tag"` resolves an everdict `runId` via `POST /api/3.0/mlflow/traces/search` — `locations` is
  REQUIRED (`experimentIds`), the filter is `` tags.`everdict.run_id` = '…' `` (backtick-quoted), and the agent-side
  tag write is `PATCH /api/3.0/mlflow/traces/{id}/tags`. Verified live against MLflow 3.14.0.
  `OtelTraceSource` `correlate:"tag"` uses the **Jaeger query API**: `GET /api/traces?service=…&tags=<JSON
  {"everdict.run_id":…}>&limit=1` — `service` is REQUIRED (400 without), the `tags` filter matches
  **resource(process) tags**, and the search response embeds full spans (same `{data:[{spans}]}` parser, one
  request). OTLP-native backends (no search API) stay id-correlated. Verified live against Jaeger 1.62.0.
- Remap upstream failures to our error model: a non-2xx → `UpstreamError` (so a pull run fails honestly), EXCEPT
  `404` → `[]` (trace not present yet; service-harness path scores 0 events).
- **Connection probe + scope discovery** (`packages/trace/src/discovery/probe-connection.ts`,
  `probeTraceConnection(cfg) → TraceProbeResult`) sits beside push/pull: one authed call per kind that
  validates the base URL + credential AND lists the platform's selectable scopes (mlflow experiments · phoenix/
  langfuse/langsmith projects · otel[jaeger] services) for the register-time picker. Same auth discipline (value
  injected, adapter owns the header). Unlike push/pull it **never throws** for reachability — it returns a
  classified `{reachable, reason?('auth'|'unreachable'|'error'), scopeKind?, scopes?}` (pure per-kind parsers +
  a 10s `Promise.race`). It lives here (IO) and is **injected** into the trace-sink/source services, so
  `application-control` never imports `@everdict/trace`. Web gates Save on it; `upsert` stays pure. See
  docs/architecture/trace-sink.md.
- **Browse + inspect + the conversion overlay** (`BrowsableTraceSource extends TraceSource`, what
  `buildTraceSource` now returns): `listTraces(opts)` enumerates a source's recent traces + observability metrics
  (started/duration/tokens/cost/status/tags — pure per-kind summary parsers) and `inspect(traceId, mapping)`
  returns the raw span attributes (span-based kinds) + events normalized with the SUPPLIED mapping + (best-effort) a
  structured `detail` (trace rollups + a span waterfall via `spansToSpanNodes` — offset/duration/type/io/tokens/cost,
  parentId nesting where the platform exposes it) — powering the Settings › Observability browser (a row-click opens
  the observability-grade detail dialog that renders the waterfall) and the judge wizard's live conversion authoring. The wizard-authored
  `SpanAttrMapping` is stored as a per-harness **overlay** (`WorkspaceSettings.spanAttrMappingByHarness`), the
  mutable conversion layer between a harness version and a judge version; `resolveHarnessTraceMapping` (overlay >
  spec) applies it at both production seams — `TraceSourceService.resolve` (dispatch-after-judge collect) and
  `ScorecardIngestService.trackPull`'s `spanMappingFor` (periodic pull-eval). See
  docs/architecture/judge-input-contract.md.
- **Evidence slots (finalAnswer/dom/screenshot) + snapshot synthesis.** `SpanAttrMapping` also carries evidence
  slots (attr-key lists, NO built-in defaults — explicit mapping only): `spansToEvidence` extracts the LAST
  defined value across time-ordered spans (= the final state) into `TraceEvidence`; a screenshot value classifies
  as inline bytes (data-URI/bare-base64) or a ref, and http(s) refs resolve to bytes best-effort with the source's
  own credentials (`fetchImageBase64` — a miss keeps the ref, NEVER fails the pull). The span-based sources expose
  `fetchDetailed(runId) → {events, evidence?}` (optional on the `TraceSource` contract; native kinds/fakes fall
  back to `fetch`) and `inspect` returns the same `evidence`; the extracted final answer is also appended as the
  trace's final assistant message (`withEvidenceEvents`, deduped). The pull-ingest path synthesizes
  `EnvSnapshot{kind:"browser"}` from the evidence so dom/screenshot/VLM judging works on pulled traces unchanged.
- **Sink = a trace source used as an export target (NO separate registration).** A workspace registers ONE pool
  (`WorkspaceSettings.traceSources[]`, owned by `TraceSourceService`); "export to X" is a per-harness selection
  (`traceSinkByHarness` → a source name; otel excluded — pull-only). `TraceSinkService` is the export EXECUTOR only:
  it resolves the selection against the pool (`unifiedTraceSources`, which legacy-merges the retired `traceSinks[]`)
  and builds a `TraceSinkConfig` at point of use. There is no `/workspace/trace-sinks` registration surface.
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
