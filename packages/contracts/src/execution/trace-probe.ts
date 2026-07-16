// Connection-test + scope-discovery for a trace source/sink before it is registered. The pure types;
// the fetch-backed engine (probeTraceConnection) lives in @everdict/trace, injected into the services
// (application-control depends on @everdict/contracts only — see the trace-sink service). The wire Zod
// schema (the parse boundary) is wire/trace-probe/trace-probe-result.ts, mirroring runtime-probe.

// What a discovered scope represents, per platform kind.
export type TraceScopeKind = "experiment" | "project" | "service";

// One selectable platform scope — id is the value stored on the source/sink config (mlflow experiment_id,
// phoenix/langsmith project id, otel service name); name is the human label shown in the picker.
export interface TraceScopeOption {
  id: string;
  name: string;
}

// The probe input — a thin subset of TraceSourceConfig/TraceSinkConfig: just enough to open a connection and
// list scopes. correlate/service/project are NOT needed (those are what discovery returns). The credential is
// the resolved VALUE (the adapter owns the header name per kind), never a secret name.
export interface TraceProbeConfig {
  kind: "otel" | "mlflow" | "langfuse" | "langsmith" | "phoenix";
  endpoint: string;
  auth?: string;
  fetchImpl?: typeof fetch; // test injection
  timeoutMs?: number; // default 10s — cap so an unreachable endpoint doesn't hang
}

// The probe outcome — a superset of RuntimeProbeResult (adds scopeKind/scopes). A classified failure is a
// normal result (never a thrown error): reason is the structured failure class, absent when reachable. scopes
// is present (possibly empty) only when reachable; scopeKind names what the list represents for this kind.
export interface TraceProbeResult {
  kind: string;
  reachable: boolean;
  detail: string;
  reason?: "auth" | "unreachable" | "error";
  scopeKind?: TraceScopeKind;
  scopes?: TraceScopeOption[];
}
