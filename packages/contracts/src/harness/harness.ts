import type { ComputeHandle } from "../execution/compute.js";
import type { SpanAttrMapping } from "../execution/trace-source.js";
import type { TraceEvent } from "../execution/trace.js";

export interface RunContext {
  // Usually empty — the claude CLI works from the machine's subscription login. Inject the key only in a sandbox without login.
  apiKeyEnv: Record<string, string>;
  timeoutSec: number;
  // Trace correlation key — runCase fills it so the same value flows to both run (the harness injects it as EVERDICT_RUN_ID/everdict.run_id)
  // and collectTrace (platform pull). If unspecified, the harness mints its own (backward-compat).
  runId?: string;
  // Cooperative cancellation — when it aborts, runCase stops consuming the harness trace and disposes the compute
  // (which force-kills the container / process), so a user "stop scorecard" frees the runtime mid-case. In-process
  // only (never crosses the wire): the self-hosted runner mints it locally on a heartbeat cancel signal. Absent = no cancellation.
  signal?: AbortSignal;
  // Live in-run screen capture (opt-in, in-process only — never crosses the wire, like `signal`). When set, runCase
  // runs a background loop that execs `captureCmd` in the compute every `intervalMs` and hands the resulting base64
  // PNG frame to `report`. The self-hosted runner supplies `report` (pushes the frame to the control plane's live-frame
  // store, keyed by runId); runCaseJob supplies `captureCmd` from the harness's declared liveScreen. Best-effort:
  // capture/report failures are swallowed and never affect the eval result. Absent = no live screen.
  liveScreen?: LiveScreenCapture;
}

// The in-process live-screen capture hook carried on RunContext. captureCmd is exec'd in the case compute and must
// print a base64 PNG to stdout and exit 0 (e.g. browser-use's headless Chromium screenshotted over CDP); report ships
// that frame to the observer (self-hosted runner → control plane). Interval defaults to 2000ms when unset.
export interface LiveScreenCapture {
  captureCmd: string;
  report: (frameBase64: string) => Promise<void>;
  intervalMs?: number;
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
  mapping?: SpanAttrMapping; // per-harness span→TraceEvent attribute overrides for non-GenAI-convention instrumentation
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
