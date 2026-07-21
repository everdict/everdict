import type { AgentJob, CaseResult } from "@everdict/contracts";

// Per-dispatch options — currently just cooperative cancellation. A backend that cannot interrupt an already-started
// run (in-process / pull) honors `signal` best-effort by rejecting a not-yet-started dispatch; the pollers (Nomad/K8s)
// additionally stop waiting and reclaim the orchestrator job when the signal aborts mid-run. Ties cancellation to the
// in-flight promise, complementing the id-keyed kill(caseId) side channel.
export interface DispatchOptions {
  signal?: AbortSignal;
  // Fired ONCE the moment the job actually begins executing — NOT at enqueue/park. Managed backends fire it at
  // dispatch() entry (= the Scheduler admitted it, past the wait queue); the self-hosted path fires it when a runner
  // LEASES the job (in-memory hub: at lease; store-backed hub: on the first "leased" outcome). Lets the caller flip
  // the run record queued→running only when compute truly starts, so a fan-out parked behind one runner reads as
  // "waiting" (queued) until picked up — not falsely "running". Best-effort; a throw must not break dispatch.
  onStarted?: () => void;
  // Fired at PARK time when a self-hosted case can't start immediately because no ONLINE capable runner exists right
  // now (paired runners are all offline / the pinned runner is offline). Non-terminal — the job still parks and runs
  // as soon as a runner reconnects (or fails at the idle timeout), but this surfaces the reason IMMEDIATELY instead of
  // the case sitting silently "queued" for ~5 minutes. `reason` is a ready-to-display, actionable sentence. The caller
  // decides how to show it (the scorecard batch appends it as a step). Best-effort; a throw must not break dispatch.
  // NOT fired when a runner is merely busy (healthy queuing) — only when nothing online can pick the job up.
  onWaiting?: (reason: string) => void;
}

// The (job)→CaseResult dispatch abstraction — satisfied by both Router (static) and Scheduler (capacity-aware).
// The control plane and the orchestrator activity depend on this PORT, not an implementation (drop-in swap).
// Moved from @everdict/backends in re-architecture P2c — placement adapters implement it, application consumes it.
export interface Dispatcher {
  dispatch(job: AgentJob, opts?: DispatchOptions): Promise<CaseResult>;
}
