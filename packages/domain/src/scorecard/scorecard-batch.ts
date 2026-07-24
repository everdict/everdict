import { BadRequestError, type CaseResult, ConflictError } from "@everdict/contracts";
import type { RunRecord, ScorecardOrigin, ScorecardRecord, ScorecardSubset } from "@everdict/contracts";
import { summarizeTrials } from "./trials.js";

// The domain model for a scorecard batch's lifecycle (queued → running → succeeded | failed | superseded | cancelled).
// Wraps the persistence record (@everdict/db ScorecardRecord — shapes unchanged); guard methods are the SSOT
// for what is legal, and transition methods guard then return the store patch. Illegal transitions throw from
// the domain. docs/architecture/rich-domain-core.md

// The patch a transition computes — the service persists it verbatim (store.update(id, patch)).
export type ScorecardTransition = Partial<ScorecardRecord>;
export type ScorecardOrchestration = NonNullable<ScorecardRecord["orchestration"]>;
export type ScorecardRunError = NonNullable<ScorecardRecord["error"]>;

// The outcome payload a terminal transition carries alongside the status flip (summary/models/export/steps/
// result references). Assembled by the orchestrating service — the domain only guards the flip and stamps it.
export type ScorecardOutcomeExtras = Partial<
  Pick<
    ScorecardRecord,
    "summary" | "models" | "judgeModels" | "export" | "steps" | "runIds" | "scorecard" | "analysisRef"
  >
>;

export interface NewQueuedBatchInput {
  id: string;
  tenant: string;
  dataset: { id: string; version: string };
  harness: { id: string; version: string }; // resolved concrete version (never "latest")
  origin?: ScorecardOrigin; // trigger provenance (submit) / retry lineage (retryOf)
  createdBy?: string; // the runner — the "who" paired with origin (the "where")
  runtime?: string; // placed runtime (work-queue axis) — unset = default backend
  subset?: ScorecardSubset; // partial-run marker — consumers know it's "not the whole thing"
  // Everything a re-drive needs (restart resume / retry-failed) — persisted at submit so the batch can be
  // reconstructed after a control-plane restart. docs/architecture/batch-resilience.md
  orchestration: ScorecardOrchestration;
  now: string;
}

// An ingest scorecard scores externally-produced traces — no dispatch loop, so it deliberately carries no
// orchestration (not resumable/retryable) and no runtime/subset. That difference is why it has its own factory.
export interface NewQueuedIngestInput {
  id: string;
  tenant: string;
  dataset: { id: string; version: string };
  harness: { id: string; version: string }; // the harness that produced the trace (label)
  origin?: ScorecardOrigin;
  createdBy?: string;
  now: string;
}

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
  runtime?: string; // the assigned runtime lane (batch runtime or per-case shard target)
  now: string;
}

export class ScorecardBatch {
  private constructor(private readonly record: ScorecardRecord) {}

  static from(record: ScorecardRecord): ScorecardBatch {
    return new ScorecardBatch(record);
  }

  // The only place a queued batch is assembled — submit's and retry-failed's record literals live here.
  static newQueued(input: NewQueuedBatchInput): ScorecardRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      dataset: input.dataset,
      harness: input.harness,
      status: "queued",
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
      ...(input.subset ? { subset: input.subset } : {}),
      orchestration: input.orchestration,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // The only place a queued ingest scorecard is assembled (push and pull share the shape).
  static newQueuedIngest(input: NewQueuedIngestInput): ScorecardRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      dataset: input.dataset,
      harness: input.harness,
      status: "queued",
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // Fan-out child run, born queued (flipped to running when compute starts; see NewChildRunInput).
  static newChildRun(input: NewChildRunInput): RunRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      harness: input.harness,
      caseId: input.caseId,
      status: "queued",
      parentScorecardId: input.parentScorecardId,
      trigger: "scorecard",
      ...(input.runtime ? { runtime: input.runtime } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // Seeded child run — a carried-over result materialized as an already-succeeded child (retry-failed on the
  // Temporal path), so the idempotent planBatch skips it and finalize aggregates it.
  static newSeededChildRun(input: Omit<NewChildRunInput, "caseId"> & { result: CaseResult }): RunRecord {
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
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // Latest child per case — a batch resumed more than once has several children for a re-run case; the newest
  // write wins. Keyed by caseId: child records don't persist a trial axis, and every caller path is single-trial
  // by construction (resume refuses multi-trial batches; the Temporal driver never fans trials out).
  static latestChildPerCase(children: RunRecord[]): Map<string, RunRecord> {
    const latest = new Map<string, RunRecord>();
    for (const c of children) {
      const prev = latest.get(c.caseId);
      if (!prev || c.updatedAt > prev.updatedAt) latest.set(c.caseId, c);
    }
    return latest;
  }

  // Terminal = the batch's outcome is settled; nothing may rewrite it (first terminal write wins).
  isTerminal(): boolean {
    return (
      this.record.status === "succeeded" ||
      this.record.status === "failed" ||
      this.record.status === "superseded" ||
      this.record.status === "cancelled"
    );
  }

  // Reclaimed by a newer fire of the same PR — live drivers skip further work on it.
  isSuperseded(): boolean {
    return this.record.status === "superseded";
  }

  // A Temporal workflow owns this batch's driver loop — boot recovery leaves it alone; supersede cancels it.
  isWorkflowOwned(): boolean {
    return this.record.orchestration?.workflowId !== undefined;
  }

  // Runs each case N>1 times (pass@k / flakiness) — child runs are keyed per (case, trial), which the
  // caseId-keyed seed paths cannot faithfully reconstruct yet. docs/architecture/trial-based-verdict.md
  isMultiTrial(): boolean {
    return (this.record.orchestration?.trials ?? 1) > 1;
  }

  // Restart resume may re-drive only an unsettled batch that persisted its orchestration inputs
  // (pre-mig records keep the INTERRUPTED tombstone path). docs/architecture/batch-resilience.md
  canResume(): boolean {
    return !this.isTerminal() && this.record.orchestration !== undefined;
  }

  // Retry-failed re-runs a FINISHED batch's failures into a new scorecard — a superseded batch is not
  // retryable (the newer fire is the answer), and multi-trial retry selection is not supported yet.
  canRetryFailed(): boolean {
    return (this.record.status === "succeeded" || this.record.status === "failed") && !this.isMultiTrial();
  }

  // Throwing form of canRetryFailed — the exact 400s the retry route has always returned.
  assertCanRetryFailed(): void {
    if (this.record.status !== "succeeded" && this.record.status !== "failed")
      throw new BadRequestError(
        "BAD_REQUEST",
        { scorecard: this.record.id, status: this.record.status },
        "Only a finished batch can be retried — wait for it to finish (or resume handles interruptions).",
      );
    if (this.isMultiTrial())
      throw new BadRequestError(
        "BAD_REQUEST",
        { scorecard: this.record.id },
        "Retrying a multi-trial (pass@k) batch is not yet supported.",
      );
  }

  // A full re-run re-executes a FINISHED batch's ENTIRE case set as a new scorecard (optionally re-scored with a
  // different grading plan / judge model / trace sink). Unlike retry-failed there is no carry-over — every case
  // re-runs — so a multi-trial batch is fine here (submit re-fans the trials); only unfinished/dead-end statuses
  // are rejected. docs/architecture/batch-resilience.md
  canRerun(): boolean {
    return this.record.status === "succeeded" || this.record.status === "failed";
  }

  // Throwing form of canRerun — the 400 the rerun route returns for a batch that has not finished.
  assertCanRerun(): void {
    if (!this.canRerun())
      throw new BadRequestError(
        "BAD_REQUEST",
        { scorecard: this.record.id, status: this.record.status },
        "Only a finished batch can be re-run — wait for it to finish (or resume handles interruptions).",
      );
  }

  // A newer fire of the same PR reclaims this batch only while it is unsettled and its provenance matches
  // the (repo, prNumber) key — the record-derived half of the supersede predicate (the harness/dataset half
  // is the caller's store query).
  canSupersede(key: { repo: string; prNumber: number }): boolean {
    return (
      !this.isTerminal() &&
      this.record.origin?.repo?.toLowerCase() === key.repo.toLowerCase() &&
      this.record.origin?.prNumber === key.prNumber
    );
  }

  // A user may stop any batch that has not yet settled (queued or running). A terminal batch is a no-op stop.
  canCancel(): boolean {
    return !this.isTerminal();
  }

  // A batch may be deleted only once it is terminal — an in-flight batch must be stopped (cancel) first, so
  // delete never has to race the live driver loop / runtime jobs (cancel already owns that teardown).
  canDelete(): boolean {
    return this.isTerminal();
  }

  // Throwing form of canDelete — deleting a live batch is a clean 409, pointing at cancel as the way out.
  assertCanDelete(): void {
    if (!this.isTerminal())
      throw new ConflictError(
        "CONFLICT",
        { scorecard: this.record.id, status: this.record.status },
        `scorecard batch is still ${this.record.status} — stop it (cancel) before deleting`,
      );
  }

  // Trial roll-up (pass@k / flakiness) — derived on read from the scorecard's repeated trials, never stored
  // (like RunRecord.usage). A no-op for a single-run batch, so the response shape is unchanged there.
  withTrialSummary(): ScorecardRecord {
    const sc = this.record.scorecard;
    if (!sc || this.record.trialSummary || !sc.results.some((r) => r.trial !== undefined)) return this.record;
    return { ...this.record, trialSummary: summarizeTrials(sc) };
  }

  // queued|running → running (the driver loop begins, or a re-attached workflow re-plans a running batch).
  start(now: string): ScorecardTransition {
    this.assertNotTerminal("start");
    return { status: "running", updatedAt: now };
  }

  // queued|running → succeeded (normal completion, with the aggregated outcome payload).
  succeed(extras: ScorecardOutcomeExtras, now: string): ScorecardTransition {
    this.assertNotTerminal("succeed");
    return { status: "succeeded", ...extras, updatedAt: now };
  }

  // queued|running → failed (a pipeline-phase error; partial results ride along for visibility).
  fail(error: ScorecardRunError, extras: ScorecardOutcomeExtras, now: string): ScorecardTransition {
    this.assertNotTerminal("fail");
    return { status: "failed", error, ...extras, updatedAt: now };
  }

  // queued|running → superseded — a newer fire (replacedBy) reclaims this batch. superseded is terminal but
  // neither success nor failure, so baseline/diff/leaderboard stay clean.
  supersede(replacedBy: string, now: string): ScorecardTransition {
    this.assertNotTerminal("supersede");
    return {
      status: "superseded",
      error: { code: "SUPERSEDED", message: `Replaced by a newer fire of the same PR (${replacedBy})` },
      updatedAt: now,
    };
  }

  // queued|running → cancelled — a user explicitly stopped this batch. cancelled is terminal but neither success
  // nor failure, so baseline/diff/leaderboard stay clean (same posture as superseded). The service aborts the
  // in-flight run and force-kills the runtime jobs after writing this status.
  cancel(now: string): ScorecardTransition {
    this.assertNotTerminal("cancel");
    return {
      status: "cancelled",
      error: { code: "CANCELLED", message: "Stopped by user" },
      updatedAt: now,
    };
  }

  // The track loop settling an aborted batch (supersede OR user cancel): attach whatever partial outcome exists
  // (results that fired, partial export, the failure that surfaced mid-abort) while KEEPING the aborted status.
  // Legal over a record already marked superseded/cancelled (the abort writes the status first, then aborts the
  // loop — the settlement PRESERVES it) — but never over a batch that settled as succeeded/failed.
  settleAborted(extras: ScorecardOutcomeExtras & { error?: ScorecardRunError }, now: string): ScorecardTransition {
    if (this.record.status === "succeeded" || this.record.status === "failed")
      throw new ConflictError(
        "CONFLICT",
        { scorecard: this.record.id, status: this.record.status },
        `scorecard batch already settled (${this.record.status}) — abort settlement rejected`,
      );
    // Preserve whichever aborted-terminal status the record already carries (cancel vs supersede); default to
    // superseded for the (unreached) case where the settlement runs over a still-queued/running record.
    const status = this.record.status === "cancelled" ? "cancelled" : "superseded";
    return { status, ...extras, updatedAt: now };
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal())
      throw new ConflictError(
        "CONFLICT",
        { scorecard: this.record.id, status: this.record.status, transition },
        `scorecard batch is already terminal (${this.record.status}) — ${transition} rejected`,
      );
  }
}
