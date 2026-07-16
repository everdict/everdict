import { z } from "zod";
import type { TraceEvent } from "./trace.js";

// Pull one run's trace that the harness exported to an observability platform and return it as
// normalized TraceEvent[] — the inbound mirror of TraceSink. Adapter interfaces live in the contract
// root (the repo's deliberate inversion); the per-platform fetch impls stay in @everdict/trace.
export interface TraceSource {
  fetch(runId: string): Promise<TraceEvent[]>;
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
