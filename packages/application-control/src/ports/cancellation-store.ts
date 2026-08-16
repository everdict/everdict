// The closed vocabulary of a cancellation operation. Two states and no more: the decision is already recorded
// on the scorecard itself (status `cancelled`/`superseded`), so this row only ever answers "has the teardown
// finished". A `failed` state would be a lie — a teardown that threw is still owed, which is exactly what
// `requested` means.
export type CancellationOperationState = "requested" | "completed";

export interface CancellationOperation {
  scorecardId: string;
  state: CancellationOperationState;
  lastError?: string;
  requestedAt: string;
  completedAt?: string;
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
// IDEMPOTENT BY KEY, not by log: a batch has exactly one cancellation, so `request` upserts on the scorecard
// id. A second request for the same batch is the same operation — a re-requested operation that had already
// completed re-opens it (the caller is telling us the teardown is being attempted again), which costs one
// extra idempotent teardown and never leaves one owed.
export interface CancellationStore {
  // Record that a teardown is owed for this batch — upsert, and it re-opens a completed row (see above).
  // Clears any previous `lastError`: that string described the attempt that just ended, not this one.
  request(scorecardId: string, now: string): Promise<void>;
  // The teardown finished. Terminal for this row; the reconciler never picks it up again.
  complete(scorecardId: string, now: string): Promise<void>;
  // The teardown threw. Records WHY and leaves the row `requested` — the operation is still owed, and the
  // error is diagnostics for an operator, never an input to whether the reconciler retries.
  fail(scorecardId: string, error: string, now: string): Promise<void>;
  // What the reconciler sweeps: operations whose teardown is not known to have finished, oldest first.
  listIncomplete(limit: number): Promise<CancellationOperation[]>;
  // One row by key — what `delete` asks before removing an aborted batch (arch-review 51 P0): a batch whose
  // teardown is still owed must not be deleted, because the reconciler closes a missing batch's operation
  // as unactionable while the leased/running work it was owed for is still burning compute.
  get(scorecardId: string): Promise<CancellationOperation | undefined>;
}

// In-process ledger for dev/test — same posture as the other InMemory stores in this package.
export class InMemoryCancellationStore implements CancellationStore {
  private readonly operations = new Map<string, CancellationOperation>();

  async request(scorecardId: string, now: string): Promise<void> {
    const prior = this.operations.get(scorecardId);
    this.operations.set(scorecardId, {
      scorecardId,
      state: "requested",
      // The first request's timestamp is the age the reconciler orders by — a re-request is the same
      // operation being attempted again, not a newer one that should go to the back of the queue.
      requestedAt: prior?.requestedAt ?? now,
    });
  }

  async complete(scorecardId: string, now: string): Promise<void> {
    const prior = this.operations.get(scorecardId);
    this.operations.set(scorecardId, {
      scorecardId,
      state: "completed",
      requestedAt: prior?.requestedAt ?? now,
      completedAt: now,
    });
  }

  async fail(scorecardId: string, error: string, now: string): Promise<void> {
    const prior = this.operations.get(scorecardId);
    this.operations.set(scorecardId, {
      scorecardId,
      state: "requested",
      lastError: error,
      requestedAt: prior?.requestedAt ?? now,
    });
  }

  async listIncomplete(limit: number): Promise<CancellationOperation[]> {
    return [...this.operations.values()]
      .filter((op) => op.state !== "completed")
      .sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : 0))
      .slice(0, limit);
  }

  async get(scorecardId: string): Promise<CancellationOperation | undefined> {
    return this.operations.get(scorecardId);
  }
}
