import type { TraceEvent } from "./trace.js";

// Export case results (trace + scores) to an external observability platform (MLflow/Langfuse/LangSmith/Phoenix) —
// the outbound mirror of TraceSource (inbound pull). The scorecard presents only a summary + link; the platform is the source of truth for detail.
// Design: docs/architecture/trace-sink.md

// One score to be mapped to the platform's score/feedback/assessment/annotation. name = Score.metric.
export interface TraceSinkScore {
  name: string;
  value: number;
  pass?: boolean;
  // Categorical outcome (MeasuredScore.label) — the human-facing result ("gold" / "timeout"). When present the
  // platform-side score shows the label, with `value` kept as the numeric ordering key.
  label?: string;
  // WHO judged: the judging model's label for a judge:<id> metric, else the batch identity (`everdict:<scorecardId>`).
  // Never a fabricated model — a harness judge with no stated model carries the batch identity too.
  source?: string;
  comment?: string; // Score.detail (when a string) — passed as rationale/explanation
}

export interface TraceSinkCase {
  caseId: string;
  trace: TraceEvent[];
  scores: TraceSinkScore[];
  // present = attach mode (flow ② — attach scores only to an existing trace), absent = create mode (flow ① — create the trace + attach).
  externalId?: string;
  // The platform trace this case was SCORED FROM, when it was scored from one. Distinct from `externalId`: the
  // export writes into whatever project/experiment the workspace configured, which is not necessarily where the
  // trace was pulled from — so this travels as a link back to the judged evidence, never as an id to write to.
  sourceTraceId?: string;
}

// Export context — carried in the platform-side trace name/tags/metadata.
export interface TraceSinkContext {
  scorecardId: string;
  dataset: string; // "id@version"
  harness: string; // "id@version"
  // Judge attribution: judge id → the model label that judged (a model judge's binding / a code judge's declared
  // model). A judge absent from the map (harness judge, unresolvable spec) exports under the batch identity —
  // the map states only what was actually declared, never an invented model.
  judgeModels?: Record<string, string>;
}

export interface TraceSinkCaseResult {
  caseId: string;
  externalId?: string; // the platform trace/run id that was created or attached to
  url?: string; // case-trace deep link
  error?: string; // per-case failure (isolated — other cases keep exporting)
  // Degraded-but-exported: the trace/scores landed, a best-effort extra (e.g. MLflow OTLP span upload) did not.
  // A warning never counts the case as failed — the status rollup reads only `error`.
  warning?: string;
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
