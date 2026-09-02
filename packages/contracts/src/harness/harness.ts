import type { ComputeHandle } from "../execution/compute.js";
import type { EnvSpec } from "../execution/environment.js";
import type { SpanAttrMapping } from "../execution/trace-source.js";
import type { TraceEvent } from "../execution/trace.js";

export interface RunContext {
  // Usually empty — the claude CLI works from the machine's subscription login. Inject the key only in a sandbox without login.
  apiKeyEnv: Record<string, string>;
  timeoutSec: number;
  // The case the harness is running, for the `{{case.*}}` tokens (harness-definability-spec.md §4) — its id and
  // its environment declaration, never its grading material.
  evalCase?: { id: string; env: EnvSpec };
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
  // Live in-run trace tee (opt-in, in-process only — never crosses the wire, like `signal`). When set, runCase hands
  // every TraceEvent it drains from the harness to `report` in batches on a short cadence, so an observer can watch
  // the trajectory accumulate while the case still runs. The self-hosted runner supplies a report that pushes to the
  // control plane's live-trace store; the managed job prints EVENT_SENTINEL stdout lines instead. Best-effort: a
  // report failure is swallowed and the sealed CaseResult.trace stays the durable record. Absent = no live trace.
  liveTrace?: LiveTraceReport;
  // Multi-turn conversation state (opt-in, in-process only — never crosses the wire, like `signal`). Only harnesses
  // marked `conversational` honor it; others ignore it and each run stays independent. Absent = one-shot run.
  conversation?: ConversationTurn;
  // Live repo-read servicing (opt-in, in-process only — never crosses the wire, like `signal`). The run workbench's
  // self-hosted parity: a control plane cannot exec into a runner's sandbox, so it PARKS fs requests and the runner
  // answers them from INSIDE the case. When set, runCase polls `poll` on a short cadence, serves each request in the
  // case compute (the same git commands the managed exec channel runs — @everdict/domain workbench-fs), and answers
  // through `answer`. Best-effort: servicing failures never touch the eval. Absent = no fs servicing.
  caseFs?: CaseFsServicing;
}

// A parked run-workbench read the control plane wants answered from inside the case (self-hosted lane).
export interface CaseFsRequest {
  id: string;
  kind: "fsTree" | "fsFile";
  path?: string; // fsFile only — repo-relative
}
// The live repo file tree / one file, as the workbench renders them (shared by both lanes — the managed exec
// channel parses the same shapes out of the same commands).
export interface CaseFsTreePayload {
  files: Array<{ path: string; status?: "modified" | "added" | "deleted" }>;
  truncated: boolean;
}
export interface CaseFsFilePayload {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string; // UTF-8 text ("" for a binary file)
  diff: string; // working-tree diff vs HEAD ("" when unchanged/untracked)
}
// The runner's answer to one parked request. An absent payload is a real answer ("not a repo" / "no such file"),
// distinct from never answering (the control plane's wait then times out to "no live sandbox").
export type CaseFsAnswer = { kind: "fsTree"; tree?: CaseFsTreePayload } | { kind: "fsFile"; file?: CaseFsFilePayload };

// The in-process servicing hook carried on RunContext (self-hosted runner → MCP lease tools behind it).
export interface CaseFsServicing {
  poll: () => Promise<CaseFsRequest[]>;
  answer: (id: string, result: CaseFsAnswer) => Promise<void>;
  intervalMs?: number; // default 2000
}

// One conversational turn's continuity contract, carried on RunContext. `resume` is the provider-native token that
// continues the previous turn (e.g. a claude session id); absent = this turn starts the conversation. The harness
// reports the token that continues THIS turn via `onToken` — possibly more than once (a resumed claude run mints a
// NEW session id, so the caller keeps the last-reported token for the next turn).
export interface ConversationTurn {
  resume?: string;
  onToken?: (token: string) => void;
}

// The in-process live-screen capture hook carried on RunContext. captureCmd is exec'd in the case compute and must
// print a base64 PNG to stdout and exit 0 (e.g. browser-use's headless Chromium screenshotted over CDP); report ships
// that frame to the observer (self-hosted runner → control plane). Interval defaults to 2000ms when unset.
export interface LiveScreenCapture {
  captureCmd: string;
  report: (frameBase64: string) => Promise<void>;
  intervalMs?: number;
}

// The in-process live-trace tee carried on RunContext. runCase buffers drained TraceEvents and flushes them to
// `report` every intervalMs (default 1000) — batched so a chatty harness costs one report per tick, not per event.
export interface LiveTraceReport {
  report: (events: TraceEvent[]) => Promise<void>;
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
  // Capability marker: run() honors RunContext.conversation (multi-turn continuity). Callers that need a
  // conversation check this BEFORE provisioning compute, so an unsupported harness is refused up front
  // instead of silently starting fresh every turn. Absent = one-shot only.
  readonly conversational?: true;
  install(compute: ComputeHandle): Promise<void>;
  run(compute: ComputeHandle, task: string, ctx: RunContext): AsyncIterable<TraceEvent>;
  // Implemented only by harnesses whose trace is stored on an external platform (OTel/MLflow) (command otel/mlflow etc.).
  // traceSource(): those platform coordinates (from the spec). collectTrace(): pull the stored trace by runId —
  // runCase calls it after releasing compute (sandbox not held during flush latency). Not implemented = run() yields the whole trace.
  traceSource?(): HarnessTraceSource | undefined;
  collectTrace?(runId: string): Promise<TraceEvent[]>;
}
