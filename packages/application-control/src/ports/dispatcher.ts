import type { AgentJob, CaseResult } from "@everdict/contracts";

// Per-dispatch options — currently just cooperative cancellation. A backend that cannot interrupt an already-started
// run (in-process / pull) honors `signal` best-effort by rejecting a not-yet-started dispatch; the pollers (Nomad/K8s)
// additionally stop waiting and reclaim the orchestrator job when the signal aborts mid-run. Ties cancellation to the
// in-flight promise, complementing the id-keyed kill(caseId) side channel.
export interface DispatchOptions {
  signal?: AbortSignal;
}

// The (job)→CaseResult dispatch abstraction — satisfied by both Router (static) and Scheduler (capacity-aware).
// The control plane and the orchestrator activity depend on this PORT, not an implementation (drop-in swap).
// Moved from @everdict/backends in re-architecture P2c — placement adapters implement it, application consumes it.
export interface Dispatcher {
  dispatch(job: AgentJob, opts?: DispatchOptions): Promise<CaseResult>;
}
