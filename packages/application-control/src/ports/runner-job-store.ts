import type { CaseJob, CaseResult } from "@everdict/contracts";

// Shared store for a MULTI-REPLICA self-hosted runner lease queue — the cross-replica counterpart to the in-process
// RunnerHub. A job parked on replica A is leased by a runner attached to replica B (atomic claim), and the parking
// replica claims the result by polling this store (same shape as StoreCallbackRendezvous). Impls: InMemory (dev /
// single-process, equivalent to the in-memory hub) and Pg (FOR UPDATE SKIP LOCKED). See docs/architecture/self-hosted-runner.md.
// Design note: capability gating is done in the store (required caps are stored at park, filtered on claim), so a
// specific-runner job whose caps a runner lacks is simply never claimed and idle-times-out (no_runner) rather than the
// in-memory hub's immediate capability_mismatch — a deliberate simplification of the store path.

// A claimed job handed to a runner.
export interface RunnerJobLease {
  jobId: string;
  job: CaseJob;
}

// What the parking replica polls to resolve/reject its dispatch promise.
export interface RunnerJobOutcome {
  status: "queued" | "leased" | "completed" | "failed" | "cancelled";
  result?: CaseResult;
  error?: string;
  ranBy?: string; // the runner that completed it (real id, not the pool "*") — for provenance
  activityAt: number; // last lease/heartbeat epoch ms — the parking replica enforces the idle timeout off this
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
export interface RunnerJobStore {
  park(input: ParkInput): Promise<void>;
  // Atomically requeue this owner's expired leases, then claim the next queued job this runner can run
  // (its own queue before the owner pool). null = nothing to take. Cross-replica safe (SKIP LOCKED).
  claim(input: ClaimInput): Promise<RunnerJobLease | null>;
  // Liveness — refresh activity_at; returns whether the job is still queued/leased and the control-plane cancel flag.
  touch(jobId: string, now: number): Promise<{ extended: boolean; cancelled: boolean }>;
  complete(jobId: string, result: CaseResult, ranBy: string): Promise<boolean>;
  fail(jobId: string, message: string): Promise<boolean>;
  // Mark a still-pending job as an idle-timeout casualty (the parking replica calls this when activity_at is stale).
  expire(jobId: string): Promise<void>;
  // The parking replica polls this to resolve/reject its dispatch promise. null = the row is gone.
  outcome(jobId: string): Promise<RunnerJobOutcome | null>;
  // User cancel / supersede — mark matching non-terminal jobs cancelled (the predicate runs in-process over candidates).
  cancel(match: (job: CaseJob) => boolean): Promise<number>;
  pending(owner: string, runnerId: string): Promise<number>;
}
