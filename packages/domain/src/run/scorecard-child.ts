import type { CaseResult, RunEnvelope, RunOrigin, RunRecord } from "@everdict/contracts";

// Scorecard fan-out children are RUNS — so the record-creation invariants live HERE, in the run family,
// beside Run's other factories (review §18: aggregate A must not assemble aggregate B's record literals —
// a field added to Run's factories and forgotten in a scorecard-side copy is exactly how the two drift).
// ScorecardBatch keeps what is genuinely ITS decision: which cases fan out, and each child's origin
// (ScorecardBatch.childRunOrigin).

// A batch fan-out child run. Like Run.newQueued it is born QUEUED (created at dispatch, flipped to running only when
// compute actually starts — a runner leases it / a managed backend dispatches it), so a fan-out parked behind one
// runner reads as "waiting", not falsely "running". Unlike Run.newQueued it never persists caseSpec (the batch
// re-plans from its dataset — the orchestration field is the resume basis, not per-child case bodies), and its
// trigger is fixed to "scorecard".
export interface NewChildRunInput {
  id: string;
  tenant: string;
  harness: { id: string; version: string };
  caseId: string;
  parentScorecardId: string;
  // The exact correlation id the dispatch will carry (`evd-<batchId>-<caseId>[-t<n>]`). Stamped here because
  // deriving it back from the row loses the trial (mig 0172).
  executionId?: string;
  runtime?: string; // the assigned runtime lane (batch runtime or per-case shard target)
  origin?: RunOrigin; // the batch's WHY, carried onto each case (schedule/member/api — execution-model.md P0)
  envelope?: RunEnvelope; // the delegated budget this case draws from (§5.2 — {id} of the causer's envelope)
  now: string;
}

// The P0 stamps every fan-out child shares: an eval-kind, batch-class task inside the scorecard's group.
function childRunShape(input: Pick<NewChildRunInput, "parentScorecardId" | "runtime" | "origin" | "envelope">) {
  return {
    kind: "eval" as const,
    class: "batch" as const,
    lifetime: "task" as const,
    group: { id: input.parentScorecardId, role: "case" as const },
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.envelope ? { envelope: input.envelope } : {}),
    ...(input.runtime ? { placement: { where: "runtime" as const, target: input.runtime } } : {}),
  };
}

// Fan-out child run, born queued (flipped to running when compute starts; see NewChildRunInput).
export function newScorecardChildRun(input: NewChildRunInput): RunRecord {
  return {
    id: input.id,
    tenant: input.tenant,
    harness: input.harness,
    caseId: input.caseId,
    status: "queued",
    parentScorecardId: input.parentScorecardId,
    trigger: "scorecard",
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...childRunShape(input),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

// Seeded child run — a carried-over result materialized as an already-succeeded child (retry-failed on the
// Temporal path), so the idempotent planBatch skips it and finalize aggregates it.
export function newSeededScorecardChildRun(
  input: Omit<NewChildRunInput, "caseId"> & { result: CaseResult },
): RunRecord {
  return {
    id: input.id,
    tenant: input.tenant,
    harness: input.harness,
    caseId: input.result.caseId,
    status: "succeeded",
    result: input.result,
    parentScorecardId: input.parentScorecardId,
    trigger: "scorecard",
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...childRunShape(input),
    createdAt: input.now,
    updatedAt: input.now,
  };
}
