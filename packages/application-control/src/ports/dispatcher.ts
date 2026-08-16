import type { AttemptRef, CaseJob, CaseResult, RuntimeWorkRef } from "@everdict/contracts";

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
  // Fired when the EXECUTING attempt turns out not to be the one the caller dispatched. The self-hosted lane
  // is where that happens: a requeued job is re-leased as a second physical execution, and that lease opens
  // its own attempt (a further re-lease fires this again, so the LAST ref is the attempt that produced the
  // evidence). The caller must seal, key its artifacts by, and name on the receipt the attempt reported here
  // rather than the one it parked with.
  //
  // It reports the attempt's NAME (arch-review 52, Wave 1), not just its recording generation. The generation
  // is absent exactly when the recording claim was refused — the `unisolated` attempt — so a hook that could
  // only speak in generations stayed SILENT on the one lane where the caller's own coordinate was already
  // wrong, and every downstream name (receipt, artifact key, terminal stamp) kept pointing at the abandoned
  // attempt. `recording` carries the fence when this attempt owns one; its absence is the fail-closed lane,
  // and a consumer must drop the generation it was holding rather than keep the predecessor's.
  //
  // Managed backends never fire it — their dispatch is the attempt. Best-effort; a throw must not break dispatch.
  onAttempt?: (attempt: AttemptRef) => void;
  // Fired the moment a placement backend CREATES external work — the K8s Job is applied, the Nomad job is
  // submitted — carrying the exact handle to it (arch-review 52, Wave 2).
  //
  // Dispatch is `(job) → result`: the caller learns the work exists only by it finishing, so the only thing it
  // could ever address the live compute by was the case id it sent in. That is not an execution (two runs of
  // one case are two jobs), and every control path built on it — stop, adopt, tail — reached strangers' work.
  // This hook is the reply the shape was missing, without splitting dispatch into start/wait: the caller
  // persists the handle (the physical-attempt ledger row) and teardown addresses THAT.
  //
  // A backend that creates no addressable external object (in-process, self-hosted lease) never fires it, and
  // a job with no `runId` does not either — a handle that cannot say which run it belongs to is the case-id
  // ambiguity again, wearing a new type. Best-effort; a throw must not break dispatch.
  onWork?: (work: RuntimeWorkRef) => void;
}

// The (job)→CaseResult dispatch abstraction — satisfied by both Router (static) and Scheduler (capacity-aware).
// The control plane and the orchestrator activity depend on this PORT, not an implementation (drop-in swap).
// Moved from @everdict/backends in re-architecture P2c — placement adapters implement it, application consumes it.
export interface Dispatcher {
  dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult>;
}
