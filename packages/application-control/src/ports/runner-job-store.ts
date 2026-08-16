import type { CaseJob, CaseResult } from "@everdict/contracts";
import type { ExecutionAttemptStore } from "./execution-attempt-store.js";

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
  // THE ATTEMPT THIS PARK IS FOR (arch-review 51). The dispatch opened a physical attempt before it reached
  // the hub, and its id is what `current_attempt_id` (mig 0183) exists to carry: the FIRST re-lease reads that
  // column as the predecessor to supersede. Written at park, that predecessor is the dispatch's own attempt —
  // which is precisely the row that used to stand `executing` for ever, because the column was NULL until a
  // re-lease minted a successor and the first mint therefore superseded nothing. Optional: a composition with
  // no attempt ledger parks exactly as before, and so does a dispatch whose open was refused.
  attemptId?: string;
}

export interface ClaimInput {
  owner: string;
  runnerId: string;
  advertisedCaps?: string[]; // undefined = no gate (backward compatible); else required ⊆ advertised
  leaseTtlMs: number; // a lease older than this (dead runner) is requeued before claiming
  now: number;
}

// What a claim's ledger work answers with. `job` ABSENT means "nothing to restamp" — the first lease of a job
// runs the attempt its dispatch already opened, so the row's job is already right and no write is owed.
export interface ClaimedAttempt {
  job?: CaseJob;
  // The attempt the ROW will name from now on — read by the NEXT claim as the predecessor to supersede.
  // Absent leaves the pointer as it was: a mint that opened no attempt has no successor to name.
  attemptId?: string;
}

// The ledger half of a claim, run INSIDE the claim's transaction (see `claimAttempt`). It receives the claim
// that just won and the ledger to write through — a transaction-bound twin when the implementation could bind
// one, `undefined` when it could not (the in-memory twin, whose caller uses its own ambient ledger instead) —
// plus `prior`, the attempt the row currently names.
export type ClaimAttemptMint = (
  claimed: RunnerJobLease,
  ledger: { attempts?: ExecutionAttemptStore; prior?: string },
) => Promise<ClaimedAttempt>;

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
  // ── ONE TRANSITION MINTS A COMPLETE ATTEMPT (arch-review 47 §5.1) ──────────────────────────────────
  //
  // The re-lease used to be three independent round-trips — `claim`, then the hub's attempt open, then
  // `restampJob` — and the gaps between them were where the store lane's attempt lifecycle went missing:
  //
  //   ① THE PREDECESSOR COULD NOT BE SUPERSEDED. Its id was on no row, and the claim that opened it may have
  //     been served by another replica, so the abandoned attempt stood `executing` for ever beside its
  //     successor. The row now carries `current_attempt_id` (mig 0183) precisely so that id can travel
  //     between replicas, and this call is what reads it, ends it, and writes the successor's back.
  //   ② THE RESTAMP COULD BE REFUSED. The row moved while the open was in flight (a cancel, an expiry
  //     sweep, another claim) and the freshly-opened attempt had to be superseded again — a lost claim, wasted
  //     ledger writes, and a runner that had to be handed nothing. Inside one transaction the claim HOLDS the
  //     row, so nothing can move it: the restamp cannot be refused, and that whole failure mode is gone.
  //   ③ THE `executing` STAMP AND ITS LEASE EPOCH WERE BEST-EFFORT. They rode no transaction, so a crash left
  //     an attempt that never recorded starting under the epoch that authorized it.
  //
  // THE CONTRACT: the claim, the predecessor's supersede, the new attempt's insert (state `executing`, lease
  // epoch stamped), the job restamp and `current_attempt_id` are ALL-OR-NOTHING. A mint that throws rolls the
  // claim back too — the job stays claimable and no attempt is left behind, because "the ledger could not
  // record this attempt" and "this runner holds a lease" must not both be true.
  //
  // A mint that produces NO attempt (the recording claim was refused, or this is a first lease that mints
  // nothing) still COMPLETES the claim: the execution is about to happen either way, so the lease is real and
  // only the fence is missing — the fail-closed lane the whole attempt plane already documents
  // (ports/execution-attempt-store.ts). The attempt ROW still inserts in the refused-recording case; what is
  // stripped is the recording generation the job carries, which is what puts the producers on the live-only
  // lane. Optional because a store with no transaction to offer must not pretend: a caller reaching for this
  // and not finding it keeps the three-step path rather than getting a version of it with a window in it.
  claimAttempt?(input: ClaimInput, mint: ClaimAttemptMint): Promise<RunnerJobLease | null>;
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
