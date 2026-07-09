import type { AgentJob, CaseResult } from "@everdict/core";

// Result of a one-shot in-container exec (Observable.exec) — the sandbox command's stdout/stderr/exit.
export interface ExecInContainer {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// A live interactive shell stream inside a case container (Shellable.execStream) — the WS terminal route drives it.
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

// The (job)→CaseResult dispatch abstraction — satisfied by both Router (static) and Scheduler (capacity-aware).
// The orchestrator/activity depends on this interface, not the implementation (drop-in swap).
export interface Dispatcher {
  dispatch(job: AgentJob): Promise<CaseResult>;
}

// The CORE placement contract — every backend implements this. "Where does it run": the control plane holds the
// backends and routes jobs; isolation is provided by each backend's runtime (Nomad task driver / K8s runtimeClass /
// Windows VM). Anything beyond dispatch+capacity is an OPTIONAL capability (see the capability interfaces below) —
// expressed as a separate interface + a narrowing guard, NOT as optional methods on this one, so a caller narrows
// with `isObservable(backend)` (compiler-checked) instead of feature-detecting `backend.logs` (undefined at runtime).
export interface Backend extends Dispatcher {
  capacity(): Promise<BackendCapacity>; // for capacity-aware placement — free concurrent slots
}

// --- Capability interfaces: a backend MAY additionally implement any of these. Narrow to them with the guards below. ---

// Recoverable — reclaim a case's orchestrator job without re-running it. Backends whose jobs outlive the control
// plane (Nomad/K8s) implement this; in-process/pull backends do not.
export interface Recoverable {
  // Adopt an already-dispatched case job (boot recovery): find the orchestrator job this backend previously
  // submitted for the case, wait for it, and harvest its result — instead of re-dispatching and double-spending
  // compute. undefined = nothing adoptable (no job / logs unreadable) → the caller re-dispatches. Best-effort.
  adopt(caseId: string): Promise<CaseResult | undefined>;
  // Force-stop every live orchestrator job of a case (superseded batch reclaim). Best-effort, never throws.
  kill(caseId: string): Promise<void>;
}

// Observable — live-progress introspection into a case's running sandbox (logs + one-shot exec). The sandbox is
// already untrusted+isolated, so the control plane gates WHO may call these (run creator / workspace admin).
export interface Observable {
  // Current stdout of the case's newest orchestrator job (live-progress observability). Raw text with the result
  // sentinel stripped; undefined = no job / logs unreadable. Snapshot semantics — callers poll and diff for a tail.
  logs(caseId: string): Promise<string | undefined>;
  // Run a one-shot command INSIDE the case's live sandbox container (web terminal / live-screen capture). The
  // command is passed to `sh -c`. undefined = no live container to exec into. Best-effort.
  exec(caseId: string, command: string): Promise<ExecInContainer | undefined>;
}

// Shellable — an INTERACTIVE shell stream inside the case's live container (observability ⑥ — PTY over WS). Split
// from Observable because it needs a real streaming exec: Nomad (`nomad alloc exec -i`) has it, K8s does not — the
// type now says so instead of a runtime `undefined`. The control plane pipes a WebSocket to the returned handle.
export interface Shellable {
  execStream(caseId: string): Promise<ExecStreamHandle | undefined>; // undefined = no live container. Best-effort.
}

// ScreenCapturable — a live screen frame for a run's per-case browser (topology backends only). Deliberately keyed
// by the CP-minted runId (not caseId) because the browser is a per-RUN resource the control plane rediscovers by
// that id; isolating it here keeps the run-vs-case key mismatch off the core Backend/Observable contracts.
export interface ScreenCapturable {
  // base64 PNG (no data: prefix), or undefined when there's no running browser.
  captureScreen(runId: string): Promise<string | undefined>;
}

// Probeable — a connection test: a light call to the cluster API without a job, to check reachability/auth.
export interface Probeable {
  probe(): Promise<ProbeResult>;
}

// --- Narrowing guards: express capability at the type level. Prefer these over `if (backend.method)` feature detection. ---

export function isRecoverable(backend: Backend): backend is Backend & Recoverable {
  const b = backend as Partial<Recoverable>;
  return typeof b.adopt === "function" && typeof b.kill === "function";
}

export function isObservable(backend: Backend): backend is Backend & Observable {
  const b = backend as Partial<Observable>;
  return typeof b.logs === "function" && typeof b.exec === "function";
}

export function isShellable(backend: Backend): backend is Backend & Shellable {
  return typeof (backend as Partial<Shellable>).execStream === "function";
}

export function isScreenCapturable(backend: Backend): backend is Backend & ScreenCapturable {
  return typeof (backend as Partial<ScreenCapturable>).captureScreen === "function";
}

export function isProbeable(backend: Backend): backend is Backend & Probeable {
  return typeof (backend as Partial<Probeable>).probe === "function";
}
