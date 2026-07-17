import { z } from "zod";
import { type TraceEvent, TraceEventSchema } from "./trace.js";

// Pull one run's trace that the harness exported to an observability platform and return it as
// normalized TraceEvent[] — the inbound mirror of TraceSink. Adapter interfaces live in the contract
// root (the repo's deliberate inversion); the per-platform fetch impls stay in @everdict/trace.
export interface TraceSource {
  fetch(runId: string): Promise<TraceEvent[]>;
  // fetch(runId) + the judge evidence extracted via the source's configured mapping evidence slots (span-based
  // kinds; screenshot refs resolved to bytes best-effort). Optional: kinds/fakes without evidence extraction fall
  // back to fetch() (events only). The pull-ingest path synthesizes a judge snapshot from the evidence.
  fetchDetailed?(runId: string): Promise<FetchedTrace>;
}

// Options for enumerating a platform's recent traces (the browser/wizard list surface).
export interface ListTracesOptions {
  scope?: string; // platform scope to list within — mlflow experiment id · phoenix/langfuse/langsmith project · otel[jaeger] service. Falls back to the source's configured scope.
  limit?: number; // max traces to return (adapter caps to a platform maximum).
  since?: string; // ISO-8601 lower time bound (best-effort — a platform without time filtering ignores it).
}

// One row in a trace list — the observability metrics a platform reports for a whole trace (normalized across kinds).
// Everything but `id` is best-effort (a platform that doesn't report a field omits it — no silent zero).
export const TraceSummarySchema = z.object({
  id: z.string(), // the trace id (feeds inspect(traceId) and, for pull-ingest, the runId axis).
  name: z.string().optional(), // root span/trace name.
  startedAt: z.string().optional(), // ISO-8601 start time.
  durationMs: z.number().nonnegative().optional(), // wall-clock duration.
  status: z.enum(["ok", "error", "unset"]).optional(), // normalized trace status.
  tokens: z
    .object({ input: z.number().int().nonnegative().optional(), output: z.number().int().nonnegative().optional() })
    .optional(),
  costUsd: z.number().nonnegative().optional(),
  llmModel: z.string().optional(), // the primary/first model observed (a hint for the list column).
  spanCount: z.number().int().nonnegative().optional(),
  tags: z.record(z.string(), z.string()).optional(), // platform tags (e.g. everdict.run_id) — passthrough for correlation display.
  scope: z.string().optional(), // the scope this trace was listed under (experiment/project/service).
});
export type TraceSummary = z.infer<typeof TraceSummarySchema>;

// One span's raw attributes — surfaced by inspect() (span-based kinds only) so a user authoring a SpanAttrMapping
// can see the actual attribute keys present before mapping them onto TraceEvent fields.
export const SpanAttrSampleSchema = z.object({
  spanName: z.string(),
  attrs: z.record(z.string(), z.unknown()),
});
export type SpanAttrSample = z.infer<typeof SpanAttrSampleSchema>;

// One node of the trace's structured span tree — the observability-grade detail a platform UI shows (waterfall + I/O).
// Best-effort per platform (span-based kinds populate it fully; native kinds may omit it): the offsets/durations drive
// the waterfall, parentId the nesting (flat when the platform doesn't expose it), and input/output/tokens/cost the
// selected-span pane. `attributes` is the raw span attribute bag (for the attributes table).
export const TraceSpanNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().optional(), // absent = a root (or the platform doesn't expose parentage → flat waterfall)
  name: z.string(),
  type: z.enum(["agent", "llm", "tool", "retriever", "chain", "span"]),
  startOffsetMs: z.number().nonnegative(), // start relative to the trace's first span
  durationMs: z.number().nonnegative(),
  attributes: z.record(z.string(), z.unknown()),
  input: z.string().optional(),
  output: z.string().optional(),
  model: z.string().optional(),
  tokens: z
    .object({ input: z.number().int().nonnegative().optional(), output: z.number().int().nonnegative().optional() })
    .optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type TraceSpanNode = z.infer<typeof TraceSpanNodeSchema>;

// Judge evidence extracted from a pulled trace via the mapping's evidence slots — the pull-path substitute for the
// EnvSnapshot a live run produces. The ingest pipeline synthesizes a browser snapshot from it, so dom/screenshot
// judging (incl. VLM) works on externally-run traces exactly as on Everdict-run ones.
export const TraceEvidenceSchema = z.object({
  finalAnswer: z.string().optional(), // the agent's final answer text
  dom: z.string().optional(), // the final DOM/HTML
  screenshotRef: z.string().optional(), // an unresolved screenshot reference (URL/path) — kept when bytes can't be fetched
  screenshot: z.string().optional(), // screenshot bytes as base64 (inline attr value or fetched from the ref)
  screenshotMediaType: z.string().optional(), // e.g. "image/png" — set only when `screenshot` is set
  custom: z.record(z.string(), z.string()).optional(), // resolved custom slots (name → text) → the judge's {<name>} placeholders
});
export type TraceEvidence = z.infer<typeof TraceEvidenceSchema>;

// The result of inspect(traceId, mapping): the normalized events (with the SUPPLIED mapping applied for span-based
// kinds) plus, for span-based kinds, the raw span attributes so a mapping can be authored/iterated live, plus (best-
// effort) the structured `detail` (rollups + span tree) the observability-grade detail dialog renders as a waterfall.
export const TraceInspectResultSchema = z.object({
  rawAttributes: z.array(SpanAttrSampleSchema).optional(), // span-based (otel/mlflow) only; native kinds omit it.
  events: z.array(TraceEventSchema),
  evidence: TraceEvidenceSchema.optional(), // evidence-slot extraction result (span-based kinds, when the mapping sets slots)
  detail: z
    .object({
      rollup: TraceSummarySchema.omit({ id: true }).optional(), // trace-level totals (duration/spanCount/tokens/cost/model/status/startedAt)
      spans: z.array(TraceSpanNodeSchema), // the waterfall nodes (ordered; empty when the platform gives no spans)
    })
    .optional(),
});
export type TraceInspectResult = z.infer<typeof TraceInspectResultSchema>;

// fetch() + the extracted evidence in one pull — what the pull-ingest path consumes to synthesize a judge snapshot.
export interface FetchedTrace {
  events: TraceEvent[];
  evidence?: TraceEvidence;
}

// A TraceSource that can also enumerate its recent traces and inspect one (raw spans + re-normalize with a supplied
// mapping). buildTraceSource returns this; consumers that only pull-by-id keep using the narrower TraceSource.
export interface BrowsableTraceSource extends TraceSource {
  listTraces(opts?: ListTracesOptions): Promise<TraceSummary[]>;
  // inspect a specific trace by id. Span-based kinds (otel/mlflow) apply `mapping` (overriding the source's configured
  // mapping) and include rawAttributes; native kinds (langfuse/langsmith/phoenix) ignore mapping and omit rawAttributes.
  inspect(traceId: string, mapping?: SpanAttrMapping): Promise<TraceInspectResult>;
}

// One evidence selector — WHERE in the trace an evidence slot's value comes from. A bare string is shorthand for
// { key } (wire-compat with the original attr-key lists). `path` reaches INSIDE a JSON attr value (an object or a
// JSON string) with a deliberately-simple dot/bracket syntax — "final_answer", "steps[2].action" — NOT full JSONPath.
export const EvidenceSelectorSchema = z.object({
  key: z.string(), // the span-attribute key holding the value (or the JSON container of it)
  path: z.string().optional(), // dot/bracket path into the attr value; absent = the whole value
  pick: z.enum(["last", "first"]).optional(), // which span wins when several carry the key (default "last" = final state)
});
export type EvidenceSelector = z.infer<typeof EvidenceSelectorSchema>;

// An evidence slot = ordered selectors; the FIRST selector that yields a value wins (selector-major resolution).
export const EvidenceSlotSchema = z.array(z.union([z.string(), EvidenceSelectorSchema]));
export type EvidenceSlot = z.infer<typeof EvidenceSlotSchema>;

// Custom evidence-slot names must be template-placeholder-safe and must not shadow the structural/fixed placeholders.
export const RESERVED_EVIDENCE_NAMES = new Set([
  "task",
  "rubric",
  "criteria",
  "dom",
  "expected",
  "final_answer",
  "finalAnswer",
  "response",
  "trace",
  "screenshot",
  "verdict_instruction",
]);
const EVIDENCE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

// Per-harness span-attribute mapping — the escape hatch for a harness that does NOT emit the OTel GenAI semantic
// conventions the span→TraceEvent normalizer defaults to. Each field lists attribute keys to try FIRST (before the
// built-in GenAI/MLflow defaults) when deriving that TraceEvent field. Applies to the span-based sources (otel/mlflow).
// The evidence slots (finalAnswer/dom/screenshot + the free-form `evidence` record) have NO built-in defaults — they
// extract judge evidence from the trace itself, so a pulled trace can carry the evidence a run-produced snapshot
// would. Custom `evidence` names become judge promptTemplate placeholders ({<name>}) — the judge DECLARES named
// evidence; the harness overlay REALIZES each name from its own trace (docs/architecture/judge-input-contract.md).
export const SpanAttrMappingSchema = z.object({
  model: z.array(z.string()).optional(), // → llm_call.model
  inputTokens: z.array(z.string()).optional(), // → llm_call.cost.inputTokens
  outputTokens: z.array(z.string()).optional(), // → llm_call.cost.outputTokens
  costUsd: z.array(z.string()).optional(), // → llm_call.cost.usd
  toolName: z.array(z.string()).optional(), // → tool_call.name
  toolCallId: z.array(z.string()).optional(), // → tool_call.id
  toolArgs: z.array(z.string()).optional(), // → tool_call.args
  toolResult: z.array(z.string()).optional(), // → tool_result.output
  messageText: z.array(z.string()).optional(), // → message.text
  finalAnswer: EvidenceSlotSchema.optional(), // → evidence.finalAnswer (+ appended as the trace's final assistant message)
  dom: EvidenceSlotSchema.optional(), // → evidence.dom (the final DOM a browser judge reads; URL values auto-fetch)
  screenshot: EvidenceSlotSchema.optional(), // → evidence.screenshot* (data-URI/base64 inline, else a fetchable ref)
  // Custom named evidence slots → evidence.custom.<name> → the judge's {<name>} placeholder (URL values auto-fetch).
  evidence: z
    .record(
      z
        .string()
        .regex(EVIDENCE_NAME_RE, "evidence slot names must be template-placeholder-safe identifiers")
        .refine((name) => !RESERVED_EVIDENCE_NAMES.has(name), {
          message: "evidence slot name shadows a built-in placeholder",
        }),
      EvidenceSlotSchema,
    )
    .optional(),
});
export type SpanAttrMapping = z.infer<typeof SpanAttrMappingSchema>;

// Config → the buildTraceSource factory input (@everdict/trace). Symmetric with TraceSinkConfig.
export interface TraceSourceConfig {
  kind: "otel" | "mlflow" | "langfuse" | "langsmith" | "phoenix";
  endpoint: string;
  headers?: Record<string, string>; // tenant credentials (e.g. Authorization: Bearer ...). Injected from the SecretStore.
  // The credential 'value' (resolved from the SecretStore) — the header name is owned by the adapter per platform convention
  // (langfuse/phoenix: Authorization verbatim, langsmith: x-api-key). otel/mlflow keep the existing headers path.
  auth?: string;
  project?: string; // required for phoenix's span-query path (project name/ID) · experiment id for mlflow tag correlation. Ignored by other kinds.
  correlate?: "id" | "tag"; // mlflow/otel — "tag" finds the trace by searching the everdict.run_id tag (resource attribute) (default "id").
  service?: string; // search scope for otel tag correlation (the Jaeger service parameter). Ignored by other kinds.
  mapping?: SpanAttrMapping; // per-harness span-attribute overrides for a non-GenAI-convention harness (otel/mlflow).
  fetchImpl?: typeof fetch;
}
