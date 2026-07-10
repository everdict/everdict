// TraceSource is the contract root's adapter interface (the repo's deliberate inversion); the trace package
// owns the fetch-backed impls and re-exports the contract here so an adapter consumer imports both together.
export type { TraceSource } from "@everdict/contracts";
export { type Span, spansToTraceEvents } from "./sources/trace-source.js";
export { OtelTraceSource, type OtelTraceSourceOptions, parseOtlpSpans, parseJaegerSpans } from "./sources/otel.js";
export { MlflowTraceSource, type MlflowTraceSourceOptions, parseMlflowTrace } from "./sources/mlflow.js";
export type { TraceSourceConfig } from "@everdict/contracts";
export { buildTraceSource } from "./sources/build-source.js";
export {
  LangfuseTraceSource,
  type LangfuseTraceSourceOptions,
  langfuseObservationsToTraceEvents,
} from "./sources/langfuse-source.js";
export {
  LangsmithTraceSource,
  type LangsmithTraceSourceOptions,
  langsmithRunsToTraceEvents,
} from "./sources/langsmith-source.js";
export {
  PhoenixTraceSource,
  type PhoenixTraceSourceOptions,
  phoenixSpansToTraceEvents,
} from "./sources/phoenix-source.js";
// TraceSink + its case/score shapes are contract-root adapter interfaces; the trace package owns the
// fetch-backed sink impls and re-exports the contract here so an adapter consumer imports both together.
export type {
  TraceSink,
  TraceSinkCase,
  TraceSinkCaseResult,
  TraceSinkConfig,
  TraceSinkContext,
  TraceSinkResult,
  TraceSinkScore,
} from "@everdict/contracts";
export { buildTraceSink } from "./sinks/build-sink.js";
export {
  MlflowTraceSink,
  type MlflowTraceSinkOptions,
  mlflowAssessmentBody,
  mlflowOtlpSpans,
  mlflowTraceBody,
} from "./sinks/mlflow-sink.js";
export {
  LangfuseTraceSink,
  type LangfuseTraceSinkOptions,
  chunkLangfuseEvents,
  langfuseBatch,
} from "./sinks/langfuse-sink.js";
export {
  LangsmithTraceSink,
  type LangsmithTraceSinkOptions,
  langsmithFeedbackBody,
  langsmithRunBody,
} from "./sinks/langsmith-sink.js";
export {
  PhoenixTraceSink,
  type PhoenixTraceSinkOptions,
  phoenixAnnotation,
  phoenixSpans,
} from "./sinks/phoenix-sink.js";
export {
  createUsageProxy,
  startUsageProxy,
  extractUsage,
  costFromHeaders,
  inMemoryUsageTally,
  type RunUsage,
  type UsageTally,
  type UsageProxy,
  type UsageProxyOptions,
  type StartedUsageProxy,
} from "./usage-proxy.js";
