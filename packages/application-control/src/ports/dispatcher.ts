import type {
  ActivationDecision,
  AttemptRef,
  CaseJob,
  CaseResult,
  PersistedWorkIntent,
  RuntimeWorkRef,
} from "@everdict/contracts";

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
  // Fired BEFORE a placement backend creates external work, carrying the exact handle it is about to create
  // (arch-review 53, Wave A — it replaces Wave 2's `onWork`, which fired after).
  //
  // The ordering is the whole contract. Wave 2's hook reported the handle once the K8s Job was applied and
  // the Nomad job submitted, which meant a control plane that died in that window left a running job nothing
  // could address: teardown fell back to the case-id kill (reaching other runs' work) and recovery could not
  // adopt at all. Both backends can NAME the object without creating it — `reserve()` is pure — so the
  // decision is made, handed here to be made durable, and only then executed.
  //
  // AWAITED, and a rejection ABORTS THE DISPATCH before any external object exists. That is the inversion:
  // under the old contract a handle that failed to persist still produced compute, so an unaddressable job
  // was a SUCCESSFUL dispatch. A caller that cannot record where the work will be must not have the work.
  //
  // A backend that creates no addressable external object (in-process, self-hosted lease) never fires it, and
  // a job with no `runId` does not either — a handle that cannot say which run it belongs to is the case-id
  // ambiguity again, wearing a new type.
  //
  // IT RETURNS THE STORE'S PROOF (arch-review 54, Phase 1), and the backend requires that proof before it
  // submits. Ordering alone was not enough: the hook could resolve having written nothing — no ledger wired,
  // no attempt id on the handle, an UPDATE that matched no row — and a resolved hook is indistinguishable
  // from a persisted reservation. `PersistedWorkIntent` exists only if a row was actually written, so
  // "the reservation is durable" stops being something the backend assumes and becomes something it holds.
  //
  // Still optional on the TYPE because ledger-less lanes (the CLI, in-process dev) legitimately have no
  // reservation to make. A managed backend asked to place work for a job that carries a `runId` REFUSES when
  // it is absent, which is where the requirement is enforced — see `ManagedWorkControl` and the placement
  // conformance suite.
  // ── THE AUTHORITY TO PLACE MANAGED WORK, AS ONE CAPABILITY (arch-review 58, W2) ─────────────
  //
  // These were two optional hooks — `onReserved` and `onActivate` — and being two is what broke them. The
  // options travel through the Scheduler by an explicit allowlist, one line per hook, whose own comment reads
  // "this whitelist is the ONE place a hook can silently die". `onActivate` then died in exactly that
  // whitelist: it existed on the type, both managed backends consumed it, a producer was wired in the run
  // service, and every SaaS dispatch goes through the Scheduler, which never carried it. `requireActivation`
  // returns immediately when the hook is absent, so nothing reported the loss.
  //
  // Adding a fifth allowlist line would have fixed that instance and kept the shape. The shape is the defect:
  // two halves of ONE protocol — reserve the work, then RE-PRESENT that reservation at the moment the
  // external object is born — as independent optional fields, so every forwarder, wrapper and composition can
  // carry one and drop the other, and half a protocol type checks.
  //
  // One object. A caller either holds the authority to place managed work or it does not; a forwarder carries
  // one field; half is unrepresentable.
  authority?: ManagedDispatchAuthority;
}

// ── WHO MAY CREATE EXTERNAL WORK, AND FOR HOW LONG ──────────────────────────────────────────────────
//
// Both halves of one protocol, so they cannot travel apart. See `DispatchOptions.authority` for what being
// two independent hooks cost.
export interface ManagedDispatchAuthority {
  // Fired BEFORE a placement backend creates external work, carrying the exact handle it is about to create
  // (arch-review 53, Wave A — it replaced Wave 2's `onWork`, which fired after).
  //
  // The ordering is the whole contract. Wave 2's hook reported the handle once the K8s Job was applied and
  // the Nomad job submitted, which meant a control plane that died in that window left a running job nothing
  // could address: teardown fell back to the case-id kill (reaching other runs' work) and recovery could not
  // adopt at all. Both backends can NAME the object without creating it — `reserve()` is pure — so the
  // decision is made, handed here to be made durable, and only then executed.
  //
  // AWAITED, and a rejection ABORTS THE DISPATCH before any external object exists. Under the old contract a
  // handle that failed to persist still produced compute, so an unaddressable job was a SUCCESSFUL dispatch.
  // A caller that cannot record where the work will be must not have the work.
  //
  // IT RETURNS THE STORE'S PROOF (arch-review 54, Phase 1), and the backend requires that proof before it
  // submits: the hook could resolve having written nothing — no ledger wired, no attempt id on the handle, an
  // UPDATE that matched no row — and a resolved hook is indistinguishable from a persisted reservation.
  // `PersistedWorkIntent` exists only if a row was actually written.
  reserve(work: RuntimeWorkRef): Promise<PersistedWorkIntent>;
  // ── …AND RE-PRESENTED WHERE THE EFFECT BEGINS (arch-review 57 P0) ─────────────────────────────
  //
  // `reserve` bounds who may reserve; it cannot bound how long the reservation stays good. The caller that
  // won one held it across whatever came next, so a cancellation could kill the work, probe it absent, settle
  // every child and COMPLETE — after which the paused caller woke and created the object. Verified zero, then
  // a birth.
  //
  // Asked immediately before the external object is created, and a TRANSITION in the store
  // (`reserved → active`, conditioned on this exact work and the parent still being open), not a read. A
  // refusal is an ordinary outcome — a cancellation got there first — and the lane turns it into an aborted
  // dispatch rather than an error.
  activate(work: RuntimeWorkRef): Promise<ActivationDecision>;
}

// The (job)→CaseResult dispatch abstraction — satisfied by both Router (static) and Scheduler (capacity-aware).
// The control plane and the orchestrator activity depend on this PORT, not an implementation (drop-in swap).
// Moved from @everdict/backends in re-architecture P2c — placement adapters implement it, application consumes it.
export interface Dispatcher {
  dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult>;
}
