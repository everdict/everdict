// ── THE CLOSED VOCABULARY OF A CANCELLATION OPERATION ───────────────────────────────────────────────
//
// The decision is already recorded on the target itself (a scorecard's status `cancelled`/`superseded`, a
// run's `failed{CANCELLED}`), so this row only ever answers "has the teardown finished". A `failed` state
// would be a lie — a teardown that threw is still owed, which is exactly what `requested` means.
//
// `verifying` and `unverifiable` are Wave E's (arch-review 53). Completion used to mean "the stop commands
// returned": `kills` counted converged RESPONSES, and `stopped` means the orchestrator accepted a delete,
// not that the object is gone — a K8s Job in `Terminating` answers `stopped` while its container runs to its
// grace period, and a Nomad deregister is asynchronous by design. So an operation could complete with
// compute still burning, which is the one claim this whole protocol exists to be able to make honestly.
//
//   requested     — the teardown is owed and has not run to a readback.
//   verifying     — the stops were issued and the postcondition read is in progress or came back non-zero.
//                   Still owed; the sweep retries.
//   completed     — a readback SAW zero live work. The certificate carries what it counted.
//   completed     — and it is the ONLY terminal one (arch-review 54, Phase 5). `unverifiable` used to be a
//                   second terminal state for "the readback budget is spent and the cluster is still
//                   unreachable", which took the row out of the sweep — the only loop that would ever retry
//                   it — while the compute it describes may still be running. That distinction is real and
//                   it is an ESCALATION, not a completion: see `CancellationOperation.escalation`. The value
//                   survives in this union only because rows written before mig 0190 carry it; nothing
//                   produces it now, and 0190 returned those rows to the sweep as `verifying`.
export type CancellationOperationState = "requested" | "verifying" | "completed" | "unverifiable";
export const CANCELLATION_OPERATION_STATES: readonly CancellationOperationState[] = [
  "requested",
  "verifying",
  "completed",
  "unverifiable",
];

// ── WHAT WAS CANCELLED (arch-review 52, Wave 3) ─────────────────────────────────────────────────────
//
// The ledger was born scorecard-shaped, and the standalone run lane — which runs the SAME terminal-first
// protocol, commit-then-tear-down, with the same crash window — had none of it. Its own comment named the
// caller's retry as the teardown's owner, which is true of a 5xx and false of a crash. One protocol, two
// kinds of target: the sweep does not care what it is converging, only who knows how to converge it.
export type CancellationTargetKind = "scorecard" | "run";

export interface CancellationTarget {
  kind: CancellationTargetKind;
  id: string;
}

// ── COMPLETION IS A CERTIFICATE, NOT A RETURN (arch-review 52, Wave 3) ───────────────────────────────
//
// "The teardown function returned" is the weakest possible reason to close an operation, and it is the one
// the ledger used: every arm was fire-and-forget or catch-and-continue underneath, so `completed` meant the
// commands had been issued. What closes a row now is a re-read of the postconditions, and this is what that
// read SAW — recorded on the row so an operator asking "why does the system believe this was torn down"
// gets an answer instead of a timestamp.
//
// Deliberately a record of OBSERVATIONS, not a verdict: each field is something this process checked, and
// the honest gaps are visible by their absence (see `kills` — no field claims the orchestrator was probed
// afterwards, because it was not).
export interface CancellationCertificate {
  // When the postconditions were read back.
  at: string;
  // Children re-listed and found terminal after the teardown loop (scorecard targets). The operation
  // completes only when the live count is zero, so this is the population the zero was measured over.
  childrenTerminal?: number;
  // Every stop this teardown issued, by the answer it got. `unknown`/`failed` are absent by construction —
  // either would have kept the operation owed — so a certificate showing only stopped/absent is the claim.
  kills?: { stopped: number; absent: number };
  // ── WHAT THE READBACK SAW (arch-review 53, Wave E) ─────────────────────────────────────────────
  //
  // The fields above are an account of the CALLS this teardown made. These are an account of the WORLD it
  // left behind, taken after those calls returned — which is the difference between "the stop commands
  // converged" and "the compute is freed". An operation completes only when every one of them is zero.
  //
  // Absent (rather than 0) means this deployment cannot take that particular reading — no probe wired, no
  // scheduler to ask. Absence is not a zero: the certificate says what it SAW, and a reader must not infer
  // quiet from a measurement nobody took.
  activeManagedWork?: number;
  activeRunnerLeases?: number;
  queuedDispatchIntents?: number;
  activeWorkflows?: number;
  liveChildren?: number;
  // How many readings came back UNKNOWN — the cluster could not be asked. Non-zero keeps the operation owed;
  // it is the reason `completed` and `unverifiable` are different states rather than one optimistic one.
  unverifiable?: number;
  // Runner leases newly signalled to abort by this teardown. NOT a liveness reading: the hub's revocation
  // count reports rows it flagged this call, so a converged re-run reports 0 for "already flagged" exactly
  // as it would for "none existed". Recorded as evidence of the arm having run, never as proof of quiet.
  leasesSignalled?: number;
  // Descendant batches revoked by the causal-tree cascade (run targets) — the agent-run kill switch.
  cascadeCancelled?: number;
}

export interface CancellationOperation {
  target: CancellationTarget;
  state: CancellationOperationState;
  lastError?: string;
  requestedAt: string;
  completedAt?: string;
  // Present only on a completed row — what the completion read back (see above).
  certificate?: CancellationCertificate;
  // How many times the POSTCONDITION READ has come back non-zero for this operation (arch-review 53, Wave E).
  // Counted on the row rather than in a process, because the retries are spread across replicas and a
  // reconciler that restarted would otherwise begin the budget again. Absent = never verified (the stops
  // themselves have not run to a readback yet).
  verificationAttempts?: number;
  // ── THE ALERT, BESIDE THE DEBT (arch-review 54, Phase 5) ─────────────────────────────────────────
  //
  // Wave E closed a budget-spent operation as `unverifiable` and took it out of the sweep, reasoning that a
  // row nobody can converge must not sit owed forever pretending it might. The distinction it wanted is real
  // — "we saw zero" and "we never got to look" are different facts — but the conclusion removed the row from
  // the only loop that would ever retry it. The compute may still be running and billing; a cluster comes
  // back and a closed operation does not.
  //
  // So the DEBT and the ALERT are separate. The operation stays owed and keeps being retried, more slowly;
  // this says a human should look, and since when.
  escalation?: { kind: "unverifiable"; attempts: number; alertedAt: string; requiresOperator: true };
  // When the reconciler should next try. Absent = as soon as it comes round; set on escalation so an
  // unreachable cluster is retried at a slower cadence instead of every sweep.
  nextAttemptAt?: string;
}

// ── WHO OWNS A CANCEL'S TEARDOWN AFTER THE PROCESS DIES (arch-review 47 §5.2) ───────────────────────
//
// The cancel protocol is terminal-first: commit the CANCELLED decision, then tear the live work down (abort
// the driver, revoke the leases, kill the backend jobs, settle the children). Those two steps are separated
// on purpose — the decision must survive even if the teardown cannot run — and the interim answer to a failed
// teardown was convergence: the retry re-runs it, because the teardown is idempotent end to end.
//
// CONVERGENCE NEEDS SOMEBODY TO CONVERGE. A 5xx converges when a caller retries; a control-plane crash
// between the commit and a successful teardown has no caller left. The decision is durable, the work is not
// torn down, and nothing in the system is looking for the difference: children stay "running" forever, leases
// stay held, cluster compute keeps burning for a batch whose result nobody will read. The recovery procedure
// was a human noticing and cancelling again.
//
// This ledger makes the teardown a DURABLE OPERATION with a reconciler as its owner. `request` is written
// with the teardown attempt, not with the decision — the decision is the settle, and this row is the
// teardown's own record. Whoever runs it next (the same call, a retry, or the reconciler on another replica)
// re-runs the same idempotent steps and completes the row.
//
// IDEMPOTENT BY KEY, not by log: a target has exactly one cancellation, so `request` upserts on the target
// id. A second request for the same target is the same operation — a re-requested operation that had already
// completed re-opens it (the caller is telling us the teardown is being attempted again), which costs one
// extra idempotent teardown and never leaves one owed.
export interface CancellationStore {
  // Record that a teardown is owed for this target — upsert, and it re-opens a completed row (see above).
  // Clears any previous `lastError` and `certificate`: both described the attempt that just ended.
  request(target: CancellationTarget, now: string): Promise<void>;
  // The teardown finished, and here is what the completion read back. Terminal for this row; the reconciler
  // never picks it up again. The certificate is optional because an UNACTIONABLE operation also closes here
  // (a target that is gone, or was never aborted) and has no postconditions to have observed.
  complete(target: CancellationTarget, now: string, certificate?: CancellationCertificate): Promise<void>;
  // The teardown threw. Records WHY and leaves the row `requested` — the operation is still owed, and the
  // error is diagnostics for an operator, never an input to whether the reconciler retries.
  // `state` says WHERE the teardown got to (arch-review 53, Wave E): `requested` = the stops themselves did
  // not run, `verifying` = they ran and the postcondition read did not come back zero. Both are owed; the
  // distinction is what an operator reads to know whether compute was ever asked to stop.
  fail(target: CancellationTarget, error: string, now: string, state?: "requested" | "verifying"): Promise<void>;
  // Raise the ALERT on an operation whose postcondition could not be established within its budget — and
  // LEAVE IT OWED (arch-review 54, Phase 5). It replaces `abandon`, which closed the row: escalation says a
  // human should look, not that the system has stopped trying. `nextAttemptAt` slows the retries so an
  // unreachable cluster is not swept every cycle.
  escalate(
    target: CancellationTarget,
    reason: string,
    now: string,
    nextAttemptAt: string,
    // The attempt count this escalation is FOR. Passed rather than re-read: the caller has just made the
    // attempt that spent the budget, and a store recomputing from the row would record the previous number.
    attempts: number,
  ): Promise<void>;
  // What the reconciler sweeps: operations whose teardown is not known to have finished, oldest first. ALL
  // kinds — the coordinator dispatches each row to the teardown that knows how to converge it, and leaves
  // owed any kind it has no teardown for (a replica that cannot converge a row must not close it).
  listIncomplete(limit: number): Promise<CancellationOperation[]>;
  // One row by key — what `delete` asks before removing an aborted batch (arch-review 51 P0): a batch whose
  // teardown is still owed must not be deleted, because the reconciler closes a missing batch's operation
  // as unactionable while the leased/running work it was owed for is still burning compute.
  get(target: CancellationTarget): Promise<CancellationOperation | undefined>;
}

// In-process ledger for dev/test — same posture as the other InMemory stores in this package.
export class InMemoryCancellationStore implements CancellationStore {
  private readonly operations = new Map<string, CancellationOperation>();

  // The kind is part of the key, not merely a column: a run and a scorecard are different operations even
  // if some future id scheme lets them collide.
  private static keyOf(target: CancellationTarget): string {
    return `${target.kind}:${target.id}`;
  }

  async request(target: CancellationTarget, now: string): Promise<void> {
    const prior = this.operations.get(InMemoryCancellationStore.keyOf(target));
    this.operations.set(InMemoryCancellationStore.keyOf(target), {
      // A RE-REQUEST IS THE SAME OPERATION (arch-review 54, Phase 5). This rebuilt the row from scratch, so
      // every attempt erased `verificationAttempts` — and the teardown wrapper re-requests before each
      // attempt, which meant the budget counted to one forever and could never be spent. The counter is on
      // the row precisely because the retries are spread across processes; forgetting it here defeated that.
      ...prior,
      target,
      state: "requested",
      // The first request's timestamp is the age the reconciler orders by — a re-request is the same
      // operation being attempted again, not a newer one that should go to the back of the queue.
      requestedAt: prior?.requestedAt ?? now,
    });
  }

  async complete(target: CancellationTarget, now: string, certificate?: CancellationCertificate): Promise<void> {
    const prior = this.operations.get(InMemoryCancellationStore.keyOf(target));
    this.operations.set(InMemoryCancellationStore.keyOf(target), {
      target,
      state: "completed",
      requestedAt: prior?.requestedAt ?? now,
      completedAt: now,
      ...(certificate ? { certificate } : {}),
    });
  }

  async fail(
    target: CancellationTarget,
    error: string,
    now: string,
    state: "requested" | "verifying" = "requested",
  ): Promise<void> {
    const prior = this.operations.get(InMemoryCancellationStore.keyOf(target));
    const attempts = (prior?.verificationAttempts ?? 0) + (state === "verifying" ? 1 : 0);
    this.operations.set(InMemoryCancellationStore.keyOf(target), {
      target,
      state,
      lastError: error,
      requestedAt: prior?.requestedAt ?? now,
      ...(attempts > 0 ? { verificationAttempts: attempts } : {}),
    });
  }

  async escalate(
    target: CancellationTarget,
    reason: string,
    now: string,
    nextAttemptAt: string,
    attempts: number,
  ): Promise<void> {
    const prior = this.operations.get(InMemoryCancellationStore.keyOf(target));
    this.operations.set(InMemoryCancellationStore.keyOf(target), {
      ...prior,
      target,
      // STILL OWED — `verifying` is what it is: the stops ran and the world did not come back quiet.
      state: "verifying",
      lastError: reason,
      requestedAt: prior?.requestedAt ?? now,
      verificationAttempts: attempts,
      escalation: { kind: "unverifiable", attempts, alertedAt: now, requiresOperator: true },
      nextAttemptAt,
    });
  }

  async listIncomplete(limit: number): Promise<CancellationOperation[]> {
    return (
      [...this.operations.values()]
        // TERMINAL = completed, and only completed (arch-review 54, Phase 5) — see the Pg twin. An operation
        // we could not verify is escalated, not closed: it stays here so a cluster that comes back is met by
        // a reconciler that is still trying.
        .filter((op) => op.state !== "completed")
        .sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : 0))
        .slice(0, limit)
    );
  }

  async get(target: CancellationTarget): Promise<CancellationOperation | undefined> {
    return this.operations.get(InMemoryCancellationStore.keyOf(target));
  }
}
