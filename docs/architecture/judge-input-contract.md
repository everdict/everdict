---
kind: wiki
title: "Judge input contract — declare, preview, dry-run"
status: current
updated: 2026-09-15
anchors: [apps/api/src/core/judge/judge-preview-service.ts, packages/graders/src/judge.ts, packages/graders/src/assess-evidence.ts, packages/contracts/src/execution/span-mapping.ts, packages/trace/src/sources/evidence-resolve.ts]
---
# Judge input contract — declare, preview, dry-run

What a judge actually SEES, how a judge declares what it needs, and how a user checks both against a real trace
before registering it. The judge entity itself (the `code` kind, legacy `model`/`harness` kinds, rubrics,
placement) is `docs/judges.md`; this page is the evidence side. Related: `docs/architecture/trace-sink.md` ·
`docs/architecture/streaming-case-pipeline.md` (`collectDeferredTrace`) · skills `evaluation` / `graders`.

## Why

Judges are **runtime data, not code in the repository**: a user registers a `JudgeSpec`, never an evaluator. A
user wiring `judge × harness` must be able to see what the judge will receive before running a full scorecard,
and a judge must be able to state what evidence it needs rather than silently judging over an empty slot.

## One unit: `GradeContext`

Every evidence source produces the same `GradeContext` (`packages/contracts/src/execution/grader.ts`) — case,
trace, snapshot, optional `evidence` — and every surface consumes it without branching.

- `assembleJudgeInput(ctx, opts)` (`packages/graders/src/judge.ts`) is the SOLE `JudgeInput` constructor.
  `JudgeGrader.grade` and the preview both call it, so the preview prompt is byte-identical to a real grade.
- `previewJudge(input)` (`packages/graders/src/model-judge.ts`) renders `{ prompt, evidence, warnings }` —
  the exact prompt plus per-placeholder coverage (`present`/`chars`/`truncated`) — with no model call.
- `assessEvidence(requires, ctx)` (`packages/graders/src/assess-evidence.ts`) splits a judge's declared
  requirements into satisfied and missing.
- `withCaseMilestones` merges a case's `milestones: [{id, description}]` into the judge's criteria as
  `milestone:<id>` entries, used by both grading and preview; the metrics land as
  `judge:<judge-id>:milestone:<id>`, so a failed final answer localizes which intermediate step broke.
- Rubric-reference resolution stays in the control plane (`resolveRubric`,
  `apps/api/src/core/execution/judge-runner.ts`); the pure core receives the already-resolved rubric.

## Declaring needs: `requires`

`JudgeSpec.requires?: EvidenceRequirement[]` (`EvidenceRequirementSchema`,
`packages/contracts/src/harness/rubric-spec.ts`) — `final_answer` · `tool_call` (optionally named) · `dom` ·
`screenshot` · `artifact` (optionally by role) · `span` (by name). Absent means no coverage check; the coarse
`inputs: [trace, dom, screenshot]` modality switch on legacy model judges is unchanged. `artifact` and `span` are
satisfiable because they are `TraceEvent` kinds (`packages/contracts/src/execution/trace.ts`): the span-based
normalizer preserves structural spans and surfaces artifact refs, and langfuse/langsmith/phoenix preserve their
structural observations.

## Preview and dry-run (BFF↔MCP parity)

`JudgePreviewService` (`apps/api/src/core/judge/judge-preview-service.ts`) is the one core behind both
transports (`apps/api/src/api/judge/judge.routes.ts` · `judge.mcp.ts`). The body is `{ spec, evidence }`, where
`evidence` (`apps/api/src/api/judge/request/judge-evidence.ts`) is one of:

- `{ source: "trace", trace, task?, expected?, snapshot?, traceEvidence? }` — a trace supplied directly (pasted,
  or pulled from a connected platform); no run needed;
- `{ source: "run", runId }` — re-score a real prior run's stored trace, snapshot and case. A live round trip is
  `POST /runs` followed by this source; there is no separate synchronous dispatch path.

Surfaces:
- **`POST /judges/preview`** · MCP `preview_judge` — gate `judges:read`. No model call. For a model/harness
  judge: the rendered prompt, coverage, warnings (unfilled placeholders, a rubric that did not resolve) and the
  requirement split. For a code judge there is no prompt: coverage and requirements only.
- **`POST /judges/try`** · MCP `try_judge` — gate `scorecards:run`. A model/harness judge runs once through the
  same `JudgeRunner.run` a scorecard uses and returns its scores (a skip is a stated skip score). A code judge's
  dry-run is promoted to a REAL standalone run (`trigger: "judge-preview"`) and returns its `runId`.

Both surfaces are read/try only: they never mutate a registered judge or a stored run.

## Evidence slots on the span mapping

A pulled trace (no Everdict-run snapshot) carries judge evidence through **evidence slots** on
`SpanAttrMapping` (`packages/contracts/src/execution/span-mapping.ts`). Beside the attribute-key overrides for
`TraceEvent` fields (tried before the OTel GenAI / MLflow defaults), the mapping has:

- **Slots** `finalAnswer` · `dom` · `screenshot`, and custom `evidence: Record<name, slot>`. No built-in
  defaults — explicit mapping only. Custom names must be identifier-safe and must not shadow a built-in
  placeholder (`RESERVED_EVIDENCE_NAMES`).
- **Selectors.** A slot is an ordered list of `string | { key, path?, pick? }`: a bare string is an attribute
  key; `path` reaches inside a JSON attribute value (dot/bracket syntax, not full JSONPath); `pick` chooses the
  span occurrence (`last` by default). The first selector that yields a value wins.
- **Resolution** (`packages/trace`): `spansToEvidence` builds `TraceEvidence { finalAnswer?, dom?,
  screenshotRef?, screenshot?, screenshotMediaType?, custom? }`; `withEvidenceEvents` also appends the final
  answer as the trace's last assistant message. `TraceSource.fetchDetailed?` returns `{ events, evidence? }`.
- **Fetching** (`packages/trace/src/sources/evidence-resolve.ts`): a `dom` or custom value that is an http(s)
  URL is fetched as text (`fetchTextArtifact`, 1 MB cap); a screenshot ref is fetched as an image
  (`fetchImageBase64`, 4 MB cap) best-effort — a miss keeps the ref. `finalAnswer` is never fetched.
  Credentials travel same-origin only; a URL on another origin is fetched bare.
- **Snapshot synthesis.** On pull ingest, evidence carrying a browser signal becomes an
  `EnvSnapshot{kind:"browser"}` on the ingested `CaseResult` (`snapshotFromEvidence`,
  `packages/contracts/src/execution/trace-source.ts`), so `dom`/`screenshot` inputs and requirements work on
  pulled traces exactly as on Everdict-run ones.
- **Custom placeholders.** Resolved custom values ride `CaseResult.evidence` → `GradeContext.evidence` →
  `JudgeInput.custom` and expand a template's `{<name>}`; an unbound name stays verbatim and the preview warns
  (`customPlaceholdersOf`). A code judge reads them as `ctx.evidence`.

## Sampling real traces, and the per-harness overlay

- **`BrowsableTraceSource`** (`@everdict/contracts`, implementations in `@everdict/trace`) adds
  `listTraces(opts)` and `inspect(traceId, mapping)` to `TraceSource`, for the five kinds otel · mlflow ·
  langfuse · langsmith · phoenix.
- **Routes / MCP** (`apps/api/src/api/trace-source/trace-source.routes.ts` · `trace-source.mcp.ts`):
  `GET /workspace/trace-sources/:name/traces` (`list_trace_source_traces`),
  `POST /workspace/trace-sources/:name/traces/:traceId/inspect` (`inspect_trace`) — both `harnesses:read`;
  `GET /harnesses/:id/span-attr-mapping` (`get_harness_span_attr_mapping`, `harnesses:read`) and
  `PUT /harnesses/:id/span-attr-mapping` (`set_harness_span_attr_mapping`, `harnesses:register`).
- **Overlay storage**: `WorkspaceSettings.spanAttrMappingByHarness` (harness id → `SpanAttrMapping`) — a mutable
  conversion layer between a harness version and a judge version, editable without bumping either immutable
  spec. The overlay wins over the spec's mapping at its two consumers: `TraceSourceService.resolve` (the
  collect-after-dispatch path) and pull-eval ingest (`ScorecardIngestService` via `spanMappingFor`). Span-based
  kinds (otel/mlflow) only; native kinds normalize with fixed converters.

## Web

- **Judge registration** (`apps/web/src/features/register-judge`) authors a code judge. Its run panel picks a
  real trace from a connected platform with the shared `TraceBrowser` (`apps/web/src/features/browse-traces`),
  inspects it, and dry-runs the draft over `POST /judges/try`, polling the resulting run to its verdict. It does
  not author span mappings.
- **Harness registration** (`apps/web/src/features/register-harness`) carries the `SpanMappingEditor` for the
  spec's attribute-key mapping; evidence slots loaded from a spec are preserved on save but have no editor. The
  overlay is written through the API/MCP only.
- **Settings › Observability** browses traces with the same `TraceBrowser` (wrapped by
  `ObservabilityTraceBrowser`, `apps/web/src/widgets/infra-panel`).

## Non-goals

- No new scoring engine — the dry-run is the existing `JudgeRunner.run` or a real run.
- No per-criterion evidence projection: every criterion sees the assembled input; `requires` declares presence.
- No preview of a harness judge's own internals — its trace stays opaque; preview covers the input handed to it.
