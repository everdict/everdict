import type { CaseJob, CaseResult } from "@everdict/contracts";

// Shared store for a MULTI-REPLICA self-hosted runner lease queue — the cross-replica counterpart to the in-process
// RunnerHub. A job parked on replica A is leased by a runner attached to replica B (atomic claim), and the parking
// replica claims the result by polling this store (same shape as StoreCallbackRendezvous). Impls: InMemory (dev /
// single-process, equivalent to the in-memory hub) and Pg (FOR UPDATE SKIP LOCKED). See docs/architecture/self-hosted-runner.md.
// Design note: capability gating is done in the store (required caps are stored at park, filtered on claim), so a
// specific-runner job whose caps a runner lacks is simply never claimed and idle-times-out (no_runner) rather than the
// in-memory hub's immediate capability_mismatch — a deliberate simplification of the store path.

// A claimed job handed to a runner. `leaseEpoch` is minted by the claim and is the physical attempt's identity:
// a requeued job is claimed again under a HIGHER epoch, so the previous holder's token stops matching even
// though the job id it was given never changed.
export interface RunnerJobLease {
  jobId: string;
  job: CaseJob;
  leaseEpoch: number;
}

// What the parking replica polls to resolve/reject its dispatch promise.
export interface RunnerJobOutcome {
  status: "queued" | "leased" | "completed" | "failed" | "cancelled";
  result?: CaseResult;
  error?: string;
  ranBy?: string; // the runner that completed it (real id, not the pool "*") — for provenance
  activityAt: number; // last lease/heartbeat epoch ms — the parking replica enforces the idle timeout off this
  // The recording generation the row's job currently carries. A re-lease restamps it (see restampJob), so the
  // parking replica reads the attempt that actually ran back off the store rather than assuming its own.
  recordingGeneration?: number;
}

export interface ParkInput {
  jobId: string;
  owner: string;
  runnerId: string; // target runner id, or POOL_RUNNER ("*") for the owner pool
  tenant?: string;
  job: CaseJob;
  requiredCaps: string[]; // functional caps this job needs — filtered against the runner's advertised set on claim
  now: number;
}

export interface ClaimInput {
  owner: string;
  runnerId: string;
  advertisedCaps?: string[]; // undefined = no gate (backward compatible); else required ⊆ advertised
  leaseTtlMs: number; // a lease older than this (dead runner) is requeued before claiming
  now: number;
}

// The port a store-backed RunnerHub binds. All ops are idempotent / no-op on a missing/terminal job.
// ⚠️ Every runner-initiated mutation (touch/complete/fail) is CONDITIONED on the current lease
// (status='leased' AND leased_by=runner AND lease_epoch=epoch) — the same predicate `authorize` reads. A
// signature with nowhere to put the epoch is how the result wire stayed unfenced while the evidence wire
// was: the store must be UNABLE to accept an outcome from a lease it no longer considers current.
// ⚠️ A CANCELLED job is revoked, not merely notified (arch-review 46): `restampJob`/`authorize`/`complete`/
// `fail` additionally require the job not to be cancel-requested, and `claim` neither requeues nor takes one.
// `touch` is the deliberate exception — see its note.
export interface RunnerJobStore {
  park(input: ParkInput): Promise<void>;
  // Atomically requeue this owner's expired leases, then claim the next queued job this runner can run
  // (its own queue before the owner pool). null = nothing to take. Cross-replica safe (SKIP LOCKED).
  claim(input: ClaimInput): Promise<RunnerJobLease | null>;
  // Replace the stored job of a lease this runner CURRENTLY holds — the lease-time attempt restamp. A claim
  // that re-leases a requeued job is a new physical execution, so the hub opens a fresh recording generation
  // for it; that number has to land on the ROW, because `authorize` answers every later evidence push out of
  // the row and would otherwise keep serving the generation the FIRST attempt opened (two executions writing
  // one recording). Conditioned on the same current-lease predicate every other runner-initiated mutation
  // uses. false = not this runner's current lease, and nothing was written.
  restampJob(jobId: string, runnerId: string, leaseEpoch: number, job: CaseJob): Promise<boolean>;
  // Liveness — refresh activity_at; returns whether the CALLER'S lease is still current and the control-plane
  // cancel flag. A stale holder's touch extends nothing (it would keep the successor's lease alive). A
  // CANCELLED lease is still answered (`{extended:false, cancelled:true}`) — the reply is how the runner is
  // told to abort — but it is no longer extended, so a runner that ignores the signal stops looking alive and
  // is reclaimed by the idle-timeout path rather than renewing the job forever.
  touch(
    jobId: string,
    runnerId: string,
    leaseEpoch: number,
    now: number,
  ): Promise<{ extended: boolean; cancelled: boolean }>;
  // Is this token the CURRENT lease, held by this runner? Returns the job it authorizes (so the caller reads the
  // run id from the lease instead of accepting one from the request), or null. Durable and therefore
  // cross-replica: the evidence a runner pushes is authorized by the same row every replica claims through.
  authorize(jobId: string, runnerId: string, leaseEpoch: number): Promise<CaseJob | null>;
  complete(jobId: string, result: CaseResult, ranBy: string, leaseEpoch: number): Promise<boolean>;
  fail(jobId: string, message: string, runnerId: string, leaseEpoch: number): Promise<boolean>;
  // Mark a still-pending job as an idle-timeout casualty (the parking replica calls this when activity_at is stale).
  expire(jobId: string): Promise<void>;
  // The parking replica polls this to resolve/reject its dispatch promise. null = the row is gone.
  outcome(jobId: string): Promise<RunnerJobOutcome | null>;
  // User cancel / supersede — mark matching non-terminal jobs cancelled (the predicate runs in-process over candidates).
  cancel(match: (job: CaseJob) => boolean): Promise<number>;
  pending(owner: string, runnerId: string): Promise<number>;
}
