import type { ComputeHandle } from "./compute.js";
import type { TraceEvent } from "./trace.js";

export interface RunContext {
  // Usually empty — the claude CLI works from the machine's subscription login. Inject the key only in a sandbox without login.
  apiKeyEnv: Record<string, string>;
  timeoutSec: number;
  // Trace correlation key — runCase fills it so the same value flows to both run (the harness injects it as EVERDICT_RUN_ID/everdict.run_id)
  // and collectTrace (platform pull). If unspecified, the harness mints its own (backward-compat).
  runId?: string;
}

// The external platform coordinates where the harness trace is stored + the collection location.
// collect="job" (default) = pull inside the job after releasing compute. "control-plane" = the job ends at execution and
// the control plane pulls via CaseResult.traceRef (only when the endpoint is reachable from the control plane —
// a cluster-internal endpoint stays job). docs/architecture/streaming-case-pipeline.md D4
export interface HarnessTraceSource {
  kind: "otel" | "mlflow" | "langfuse" | "langsmith" | "phoenix"; // same as @everdict/trace buildTraceSource's 5 kinds
  endpoint: string;
  collect: "job" | "control-plane";
  authSecret?: string; // authentication secret 'name' (the control plane reinterprets it at collect) — the value is not loaded into traceRef
  correlate?: "id" | "tag"; // mlflow/otel — with tag, correlate by searching the everdict.run_id tag (resource attribute)
  experiment?: string; // search scope for mlflow tag correlation (experiment id)
  project?: string; // phoenix only — the project on the span lookup path (required API form)
  service?: string; // search scope for otel tag correlation (Jaeger service parameter — the agent's service.name)
}

// The subject under test. Driven inside a ComputeHandle (sandbox), it converts native output
// into normalized TraceEvents and yields them. Driven across a process boundary, so the
// harness under test can be in any language (TS/Python/CLI).
export interface EvaluableHarness {
  readonly id: string;
  readonly version: string; // the unit of versioning
  install(compute: ComputeHandle): Promise<void>;
  run(compute: ComputeHandle, task: string, ctx: RunContext): AsyncIterable<TraceEvent>;
  // Implemented only by harnesses whose trace is stored on an external platform (OTel/MLflow) (command otel/mlflow etc.).
  // traceSource(): those platform coordinates (from the spec). collectTrace(): pull the stored trace by runId —
  // runCase calls it after releasing compute (sandbox not held during flush latency). Not implemented = run() yields the whole trace.
  traceSource?(): HarnessTraceSource | undefined;
  collectTrace?(runId: string): Promise<TraceEvent[]>;
}
