import type { AgentJob, CaseResult } from "@everdict/core";

// Result of a one-shot in-container exec (Backend.exec) — the sandbox command's stdout/stderr/exit.
export interface ExecInContainer {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// A live interactive shell stream inside a case container (Backend.execStream) — the WS terminal route drives it.
export interface ExecStreamHandle {
  write(data: string): void; // forward the terminal's keystrokes to the shell's stdin
  onData(cb: (chunk: string) => void): void; // shell stdout/stderr → the terminal
  onExit(cb: (code: number | null) => void): void; // the shell exited (or the container died)
  close(): void; // tear down (WS closed / run terminal)
}

// A backend's concurrent capacity. The scheduler adds its own in-flight to compute free slots.
export interface BackendCapacity {
  total: number; // upper bound of concurrent slots (static config or live probe)
  used: number; // external usage observed by the backend (0 if unknown; the scheduler additionally accounts for its own in-flight)
  // Optional memory envelope (declared, e.g. RuntimeSpec.memoryBudgetMb) — caps the SUM of in-flight
  // harness-declared memory the Scheduler admits at once. Absent = slots-only admission (previous behavior).
  memoryBudgetMb?: number;
  // Optional CPU envelope (RuntimeSpec.cpuBudget, resources.cpu units: 1000 = 1 vCPU) — same admission
  // contract as memoryBudgetMb for the SUM of in-flight harness-declared cpu.
  cpuBudget?: number;
}

// Runtime connection probe result — without running a job, checks only "does this cluster actually connect (reachability + auth)".
// Surfaces the "will it connect, unknown" that schema validate() at registration time couldn't tell.
export interface ProbeResult {
  reachable: boolean; // reached the cluster API + (if credentials exist) authenticated successfully
  detail: string; // success: identifying info like version/name; failure: reason (status code/error message)
}

// The upper layer of "where does it run" (placement). The control plane holds the backends and routes jobs.
// Isolation is provided by each backend's runtime (Nomad task driver / K8s runtimeClass / Windows VM).
export interface Backend {
  readonly id: string;
  capacity(): Promise<BackendCapacity>; // for capacity-aware placement — free concurrent slots
  // Adopt an already-dispatched case job (boot recovery): find the orchestrator job this backend previously
  // submitted for the case, wait for it, and harvest its result — instead of re-dispatching and double-spending
  // compute. undefined = nothing adoptable (no job / logs unreadable) → the caller re-dispatches. Best-effort.
  adopt?(caseId: string): Promise<CaseResult | undefined>;
  // Force-stop every live orchestrator job of a case (superseded batch reclaim). Best-effort, never throws.
  kill?(caseId: string): Promise<void>;
  // Current stdout of the case's newest orchestrator job (live-progress observability). Raw text with the result
  // sentinel stripped; undefined = no job / logs unreadable. Snapshot semantics — callers poll and diff for a tail.
  logs?(caseId: string): Promise<string | undefined>;
  // Run a one-shot command INSIDE the case's live sandbox container (web terminal / live-screen capture). The
  // command is passed to `sh -c`. undefined = no live container to exec into. Best-effort; the sandbox is
  // already untrusted+isolated, so the control plane gates WHO may call this (run creator / workspace admin).
  exec?(caseId: string, command: string): Promise<ExecInContainer | undefined>;
  // Capture a live screen frame (observability ⑦) for a run's per-case browser, keyed by the CP-minted runId
  // (topology backends only). Returns base64 PNG (no data: prefix), or undefined when there's no running browser.
  captureScreen?(runId: string): Promise<string | undefined>;
  // Open an INTERACTIVE shell stream inside the case's live container (observability ⑥ — PTY over WS). The
  // control plane pipes a WebSocket to it. undefined = no live container. Best-effort; same creator/admin gate.
  execStream?(caseId: string): Promise<ExecStreamHandle | undefined>;
  dispatch(job: AgentJob): Promise<CaseResult>;
  // Connection test (optional) — sends a light call to the cluster API without a job to check reachability/auth. undefined for backends that don't implement it.
  probe?(): Promise<ProbeResult>;
}

// The (job)→CaseResult dispatch abstraction — satisfied by both Router (static) and Scheduler (capacity-aware).
// The orchestrator/activity depends on this interface, not the implementation (drop-in swap).
export interface Dispatcher {
  dispatch(job: AgentJob): Promise<CaseResult>;
}
