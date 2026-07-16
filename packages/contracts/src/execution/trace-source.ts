import { z } from "zod";
import { type TraceEvent, TraceEventSchema } from "./trace.js";

// Pull one run's trace that the harness exported to an observability platform and return it as
// normalized TraceEvent[] — the inbound mirror of TraceSink. Adapter interfaces live in the contract
// root (the repo's deliberate inversion); the per-platform fetch impls stay in @everdict/trace.
export interface TraceSource {
  fetch(runId: string): Promise<TraceEvent[]>;
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

// The result of inspect(traceId, mapping): the normalized events (with the SUPPLIED mapping applied for span-based
// kinds) plus, for span-based kinds, the raw span attributes so a mapping can be authored/iterated live.
export const TraceInspectResultSchema = z.object({
  rawAttributes: z.array(SpanAttrSampleSchema).optional(), // span-based (otel/mlflow) only; native kinds omit it.
  events: z.array(TraceEventSchema),
});
export type TraceInspectResult = z.infer<typeof TraceInspectResultSchema>;

// A TraceSource that can also enumerate its recent traces and inspect one (raw spans + re-normalize with a supplied
// mapping). buildTraceSource returns this; consumers that only pull-by-id keep using the narrower TraceSource.
export interface BrowsableTraceSource extends TraceSource {
  listTraces(opts?: ListTracesOptions): Promise<TraceSummary[]>;
  // inspect a specific trace by id. Span-based kinds (otel/mlflow) apply `mapping` (overriding the source's configured
  // mapping) and include rawAttributes; native kinds (langfuse/langsmith/phoenix) ignore mapping and omit rawAttributes.
  inspect(traceId: string, mapping?: SpanAttrMapping): Promise<TraceInspectResult>;
}

// Per-harness span-attribute mapping — the escape hatch for a harness that does NOT emit the OTel GenAI semantic
// conventions the span→TraceEvent normalizer defaults to. Each field lists attribute keys to try FIRST (before the
// built-in GenAI/MLflow defaults) when deriving that TraceEvent field. Applies to the span-based sources (otel/mlflow).
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
