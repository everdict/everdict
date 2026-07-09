import type { TraceEvent } from "@everdict/core";

// Export case results (trace + scores) to an external observability platform (MLflow/Langfuse/LangSmith/Phoenix) —
// the outbound mirror of TraceSource (inbound pull). The scorecard presents only a summary + link; the platform is the source of truth for detail.
// Design: docs/architecture/trace-sink.md

// One score to be mapped to the platform's score/feedback/assessment/annotation. name = Score.metric.
export interface TraceSinkScore {
  name: string;
  value: number;
  pass?: boolean;
  comment?: string; // Score.detail (when a string) — passed as rationale/explanation
}

export interface TraceSinkCase {
  caseId: string;
  trace: TraceEvent[];
  scores: TraceSinkScore[];
  // present = attach mode (flow ② — attach scores only to an existing trace), absent = create mode (flow ① — create the trace + attach).
  externalId?: string;
}

// Export context — carried in the platform-side trace name/tags/metadata.
export interface TraceSinkContext {
  scorecardId: string;
  dataset: string; // "id@version"
  harness: string; // "id@version"
}

export interface TraceSinkCaseResult {
  caseId: string;
  externalId?: string; // the platform trace/run id that was created or attached to
  url?: string; // case-trace deep link
  error?: string; // per-case failure (isolated — other cases keep exporting)
}

export interface TraceSinkResult {
  url?: string; // parent (experiment/project) deep link
  cases: TraceSinkCaseResult[];
}

// The adapter contract. Takes the case array at once and chooses batching/looping internally (Langfuse is one batch-ingestion call).
// A wholesale failure (auth/connect) throws UpstreamError; per-case failures are isolated in cases[].error.
export interface TraceSink {
  export(ctx: TraceSinkContext, cases: TraceSinkCase[]): Promise<TraceSinkResult>;
}

// Config → the buildTraceSink factory input. Symmetric with TraceSourceConfig.
// auth = the credential 'value' resolved from the SecretStore — the header name is owned by the adapter per platform convention
// (mlflow/langfuse/phoenix: Authorization verbatim, langsmith: x-api-key). The scheme is in the value (Basic …/Bearer …).
export interface TraceSinkConfig {
  kind: "mlflow" | "langfuse" | "langsmith" | "phoenix";
  endpoint: string;
  auth?: string;
  project?: string; // per-kind coordinate: mlflow experiment_id · langsmith project · phoenix project · langfuse projectId (link)
  webUrl?: string; // UI deep-link base (unset = endpoint)
  fetchImpl?: typeof fetch; // test injection
}
