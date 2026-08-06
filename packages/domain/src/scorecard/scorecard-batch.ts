import { BadRequestError, type CaseResult, ConflictError } from "@everdict/contracts";
import type { PlatformFact, RunOrigin } from "@everdict/contracts";
import type {
  RunEnvelope,
  RunRecord,
  ScorecardOrigin,
  ScorecardRecord,
  ScorecardSubset,
  VerdictPolicyRef,
} from "@everdict/contracts";
import { SPANS_TO_EVENTS_VERSION } from "../trace/spans-to-events.js";
import { headlinePassRate } from "./headline.js";
import { summarizeTrials } from "./trials.js";
import { verdictPolicyRef } from "./verdict-policy.js";

// The domain model for a scorecard batch's lifecycle (queued → running → succeeded | failed | superseded | cancelled).
// Wraps the persistence record (@everdict/db ScorecardRecord — shapes unchanged); guard methods are the SSOT
// for what is legal, and transition methods guard then return the store patch. Illegal transitions throw from
// the domain. docs/architecture/rich-domain-core.md

// The transition an aggregate method computes (E0, same shape as Run): the store patch the service persists
// verbatim, plus the lifecycle FACTS born in the same decision — a fact is computed where its legality is
// decided; the service stamps identity and persists both in one transaction. Transitions must never be
// spread ({...transition} silently drops both halves past the type checker) — always use .patch.
export interface ScorecardTransition {
  patch: Partial<ScorecardRecord>;
  facts: PlatformFact[];
}
export type ScorecardOrchestration = NonNullable<ScorecardRecord["orchestration"]>;
export type ScorecardRunError = NonNullable<ScorecardRecord["error"]>;

// The outcome payload a terminal transition carries alongside the status flip (summary/models/export/steps/
// result references). Assembled by the orchestrating service — the domain only guards the flip and stamps it.
// The span→event projection this batch's verdicts were computed under (N6, otel-trace-model.md). Stamped by
// the DOMAIN rather than by a caller, so no settle path can forget it: spans are immutable, but the
// projection is code, and an undated interpretation makes an old verdict impossible to re-derive.
// Also stamps WHICH verdict policy the batch's verdicts resolve under (id + version + content digest) —
// verdicts are derived on read, so the stamp is what keeps them stable when the policy evolves (mig 0125).
function judgedUnder(): { traceProjectionVersion: number; verdictPolicy: VerdictPolicyRef } {
  return { traceProjectionVersion: SPANS_TO_EVENTS_VERSION, verdictPolicy: verdictPolicyRef() };
}

export type ScorecardOutcomeExtras = Partial<
  Pick<
    ScorecardRecord,
    "summary" | "models" | "judgeModels" | "export" | "steps" | "runIds" | "scorecard" | "analysisRef"
  >
>;

export interface NewQueuedBatchInput {
  id: string;
  tenant: string;
  kind?: "experiment"; // group kind (P1) — absent = scorecard (the default); experiment = phase 1 alone, ungraded
  dataset: { id: string; version: string };
  harness: { id: string; version: string }; // resolved concrete version (never "latest")
  origin?: ScorecardOrigin; // trigger provenance (submit) / retry lineage (retryOf)
  createdBy?: string; // the runner — the "who" paired with origin (the "where")
  teamId?: string; // owning team — the "whose", beside the "who"; absent = unowned (the workspace's)
  runtime?: string; // placed runtime (work-queue axis) — unset = default backend
  subset?: ScorecardSubset; // partial-run marker — consumers know it's "not the whole thing"
  // Everything a re-drive needs (restart resume / retry-failed) — persisted at submit so the batch can be
  // reconstructed after a control-plane restart. docs/architecture/batch-resilience.md
  orchestration: ScorecardOrchestration;
  // Reproducibility digests of exactly what this batch evaluates (resolved case bundle / resolved spec /
  // grading plan) — sealed at submit, because submit is the only moment all three are in hand resolved.
  manifest?: ScorecardRecord["manifest"];
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
  teamId?: string; // owning team — an ingested batch is a team's result too, so it is not born unowned
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

// The label pair every scorecard fact carries — dataset@version × harness@version.
function batchLabels(record: ScorecardRecord): { dataset: string; harness: string } {
  return {
    dataset: `${record.dataset.id}@${record.dataset.version}`,
    harness: `${record.harness.id}@${record.harness.version}`,
  };
}

// Terminal fact (scorecard.completed/failed). The initiator gate was WIDENED (E2 coverage decision):
// machine-fired batches announce their completion too — the Mattermost channel always posted them, and
// re-basing that channel onto the log required the log to know. Personal targeting stays conditional
// (actor/recipient only with a known initiator; the feed consumer skips actor-less facts).
function batchTerminalFact(
  record: ScorecardRecord,
  status: "succeeded" | "failed",
  extras: ScorecardOutcomeExtras,
): PlatformFact[] {
  const { dataset, harness } = batchLabels(record);
  // passRate from the summary this terminal write persists (extras wins; a bare failure keeps the record's) —
  // the pointer an agent trigger can filter on (`passRate < 1`) without re-reading the full results.
  // Authority-ranked (headlinePassRate), NOT first-metric-with-a-passRate: summary order is not authority,
  // and a trigger acting on `custom_check`'s rate while `tests_pass` disagrees acts on the wrong number.
  const summary = extras.summary ?? record.summary;
  const passRate = headlinePassRate({ ...(summary ? { summary } : {}) }) ?? undefined;
  return [
    {
      kind: status === "succeeded" ? "scorecard.completed" : "scorecard.failed",
      subject: { type: "scorecard", id: record.id },
      ...(record.createdBy !== undefined ? { actor: record.createdBy, recipient: record.createdBy } : {}),
      payload: {
        status,
        dataset,
        harness,
        ...(passRate !== undefined ? { passRate } : {}),
        ...(record.origin?.source !== undefined ? { origin: record.origin.source } : {}),
      },
      message: `Scorecard ${record.id} ${status} — ${dataset} × ${harness}${passRate !== undefined ? ` (pass rate ${Math.round(passRate * 100)}%)` : ""}`,
    },
  ];
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
      ...(input.kind ? { kind: input.kind } : {}),
      dataset: input.dataset,
      harness: input.harness,
      status: "queued",
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
      ...(input.subset ? { subset: input.subset } : {}),
      orchestration: input.orchestration,
      ...(input.manifest ? { manifest: input.manifest } : {}),
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
      ...(input.teamId ? { teamId: input.teamId } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // The batch's WHY, carried onto each fan-out child (execution-model.md P0): the scorecard origin's
  // free-string source mapped onto the structured cause vocabulary. Children never guess their own cause.
  // The creation fact (scorecard.submitted) — the batch entered the system; watching agents can follow it
  // from here. The case count is submit-time knowledge (the resolved dataset), not on the record, so the
  // caller passes it. Ingest-created batches stay silent today (no submitted fact — the pre-outbox behavior);
  // widening that coverage is an E2 decision, not a default.
  static creationFacts(record: ScorecardRecord, cases: number): PlatformFact[] {
    const { dataset, harness } = batchLabels(record);
    return [
      {
        kind: "scorecard.submitted",
        subject: { type: "scorecard", id: record.id },
        ...(record.createdBy !== undefined ? { actor: record.createdBy, recipient: record.createdBy } : {}),
        payload: {
          status: record.status,
          dataset,
          harness,
          cases,
          ...(record.origin?.source !== undefined ? { origin: record.origin.source } : {}),
          ...(record.origin?.scheduleId !== undefined ? { scheduleId: record.origin.scheduleId } : {}),
        },
        message: `Scorecard ${record.id} submitted — ${dataset} × ${harness} (${cases} cases)`,
      },
    ];
  }

  static childRunOrigin(record: Pick<ScorecardRecord, "origin" | "createdBy">): RunOrigin {
    // Run-caused batches (an agent submitted this scorecard) outrank the source mapping: the children ARE
    // the agent run's downstream demand — the causedBy edge is what the P4 gate and cascade cancel walk.
    if (record.origin?.causedByRunId !== undefined)
      return {
        cause: "run",
        causedByRunId: record.origin.causedByRunId,
        ...(record.createdBy ? { actor: record.createdBy } : {}),
      };
    const source = record.origin?.source;
    if (source === "schedule") {
      return {
        cause: "schedule",
        ...(record.origin?.scheduleId ? { scheduleId: record.origin.scheduleId } : {}),
      };
    }
    if (source === "github-actions") return { cause: "ci" };
    const cause = source === "web" || source === "mcp" ? ("member" as const) : ("api" as const);
    return { cause, ...(record.createdBy ? { actor: record.createdBy } : {}) };
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
      ...childRunShape(input),
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
      ...childRunShape(input),
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
  // Phase 2 after the fact (P2): only a group that COMPLETED phase 1 can be (re-)scored — running = wait,
  // failed = retry first, cancelled/superseded = the runs were reclaimed.
  canScore(): boolean {
    return this.record.status === "succeeded";
  }

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
    return { patch: { status: "running", updatedAt: now }, facts: [] };
  }

  // queued|running → succeeded (normal completion, with the aggregated outcome payload).
  succeed(extras: ScorecardOutcomeExtras, now: string): ScorecardTransition {
    this.assertNotTerminal("succeed");
    return {
      patch: { status: "succeeded", ...extras, ...judgedUnder(), updatedAt: now },
      facts: batchTerminalFact(this.record, "succeeded", extras),
    };
  }

  // queued|running → failed (a pipeline-phase error; partial results ride along for visibility).
  fail(error: ScorecardRunError, extras: ScorecardOutcomeExtras, now: string): ScorecardTransition {
    this.assertNotTerminal("fail");
    return {
      patch: { status: "failed", error, ...extras, ...judgedUnder(), updatedAt: now },
      facts: batchTerminalFact(this.record, "failed", extras),
    };
  }

  // queued|running → superseded — a newer fire (replacedBy) reclaims this batch. superseded is terminal but
  // neither success nor failure, so baseline/diff/leaderboard stay clean.
  supersede(replacedBy: string, now: string): ScorecardTransition {
    this.assertNotTerminal("supersede");
    // No fact: a replaced batch is reclaimed plumbing, not an outcome anyone subscribed to (it also skips
    // its completion notification) — the replacing batch's own submitted fact is the signal.
    return {
      patch: {
        status: "superseded",
        error: { code: "SUPERSEDED", message: `Replaced by a newer fire of the same PR (${replacedBy})` },
        updatedAt: now,
      },
      facts: [],
    };
  }

  // queued|running → cancelled — a user explicitly stopped this batch. cancelled is terminal but neither success
  // nor failure, so baseline/diff/leaderboard stay clean (same posture as superseded). The service aborts the
  // in-flight run and force-kills the runtime jobs after writing this status.
  cancel(now: string): ScorecardTransition {
    this.assertNotTerminal("cancel");
    // The cancelled fact is born HERE — the completion path deliberately skips aborted batches, so this
    // transition is the only place the outcome is decided (settleAborted later merely attaches partials).
    const { dataset, harness } = batchLabels(this.record);
    return {
      patch: {
        status: "cancelled",
        error: { code: "CANCELLED", message: "Stopped by user" },
        updatedAt: now,
      },
      facts: [
        {
          kind: "scorecard.cancelled",
          subject: { type: "scorecard", id: this.record.id },
          ...(this.record.createdBy !== undefined
            ? { actor: this.record.createdBy, recipient: this.record.createdBy }
            : {}),
          payload: { status: "cancelled", dataset, harness },
          message: `Scorecard ${this.record.id} cancelled — ${dataset} × ${harness}`,
        },
      ],
    };
  }

  // succeeded → succeeded with phase 2 re-applied (execution-model.md P2): attach the new aggregate — scoring
  // NEVER mutates phase 1 (the runs re-score in place via write-back; the group takes the fresh aggregate).
  // Scoring an EXPERIMENT promotes it to a scorecard (a group with a verdict is definitionally a scorecard,
  // O3) — the kind flips to the EXPLICIT "scorecard" so the store can persist the change. The actor is the
  // re-scorer (not the original creator), passed by the service.
  rescore(extras: ScorecardOutcomeExtras, by: { actor?: string }, now: string): ScorecardTransition {
    if (!this.canScore())
      throw new ConflictError(
        "CONFLICT",
        { scorecard: this.record.id, status: this.record.status },
        `only a succeeded group can be scored (status: ${this.record.status})`,
      );
    const { dataset, harness } = batchLabels(this.record);
    const promoted = this.record.kind === "experiment";
    const summary = extras.summary ?? this.record.summary;
    const passRate = summary?.find((row) => row.passRate !== undefined)?.passRate;
    return {
      patch: { ...(promoted ? { kind: "scorecard" as const } : {}), ...extras, updatedAt: now },
      facts: [
        {
          kind: "scorecard.scored",
          subject: { type: "scorecard", id: this.record.id },
          ...(by.actor !== undefined ? { actor: by.actor, recipient: by.actor } : {}),
          payload: {
            status: this.record.status,
            dataset,
            harness,
            ...(passRate !== undefined ? { passRate } : {}),
            ...(promoted ? { promoted: true } : {}),
          },
          message: `Scorecard ${this.record.id} scored — ${dataset} × ${harness}${passRate !== undefined ? ` (pass rate ${Math.round(passRate * 100)}%)` : ""}${promoted ? " (promoted from experiment)" : ""}`,
        },
      ],
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
    // No fact: the cancelled fact already fired when the abort was requested; superseded settles silently.
    const status = this.record.status === "cancelled" ? "cancelled" : "superseded";
    return { patch: { status, ...extras, updatedAt: now }, facts: [] };
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
