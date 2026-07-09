import type { AgentJob, CaseResult } from "@everdict/core";

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
  dispatch(job: AgentJob): Promise<CaseResult>;
  // Connection test (optional) — sends a light call to the cluster API without a job to check reachability/auth. undefined for backends that don't implement it.
  probe?(): Promise<ProbeResult>;
}

// The (job)→CaseResult dispatch abstraction — satisfied by both Router (static) and Scheduler (capacity-aware).
// The orchestrator/activity depends on this interface, not the implementation (drop-in swap).
export interface Dispatcher {
  dispatch(job: AgentJob): Promise<CaseResult>;
}
