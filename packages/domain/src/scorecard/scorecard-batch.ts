import { BadRequestError, type CaseResult, ConflictError, TERMINAL_SCORECARD_STATUSES } from "@everdict/contracts";
import type { DomainFact, RunOrigin } from "@everdict/contracts";
import type {
  RunEnvelope,
  RunRecord,
  ScorecardDecisionContext,
  ScorecardOrigin,
  ScorecardRecord,
  ScorecardSubset,
  VerdictPolicy,
  VerdictPolicyRef,
} from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";
import { SPANS_TO_EVENTS_VERSION } from "../trace/spans-to-events.js";
import { decisionPassRate, headlinePassRate } from "./headline.js";
import { childKey } from "./scoring-plan.js";
import { summarizeTrials } from "./trials.js";
import { resolvePolicyResolution, verdictPolicyRef } from "./verdict-policy.js";

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
  facts: DomainFact[];
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
function judgedUnder(policy?: VerdictPolicy): { traceProjectionVersion: number; verdictPolicy: VerdictPolicyRef } {
  return { traceProjectionVersion: SPANS_TO_EVENTS_VERSION, verdictPolicy: verdictPolicyRef(policy) };
}

// `scoring` is the append-only scoring-identity ledger every judged settle carries; `manifest`/
// `orchestration` ride ONLY the rescore transition — a re-score rewrites scoring identity, so it refreshes
// the judge views (manifest.judges + orchestration.judges) to the merged effective set in the same write.
export type ScorecardOutcomeExtras = Partial<
  Pick<
    ScorecardRecord,
    | "summary"
    | "verdictSummary"
    // The execution WORLD this batch ran in (arch-review 20 P1) — named here so the settle transition carries
    // it as a first-class outcome field rather than as a value that happens to survive an object spread.
    | "world"
    | "models"
    | "judgeModels"
    | "export"
    | "steps"
    | "runIds"
    | "scorecard"
    | "analysisRef"
    // The settlement's OWED OUTWARD EFFECTS (arch-review 52, Wave 4). Named here for the same reason `world`
    // is: the plan has to ride the terminal transition itself — a publication decided by one write and
    // persisted by another is the very gap it exists to close.
    | "publication"
    | "scoring"
    | "scoringPass"
    | "manifest"
    | "orchestration"
    | "decision"
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
  // The batch's ASK (cases × trials) — the requested−executed gap is unrecoverable once cases were skipped.
  requested?: number;
  now: string;
}

// An ingest scorecard scores externally-produced traces — no dispatch loop, so it deliberately carries no
// orchestration (not resumable/retryable) and no runtime/subset. That difference is why it has its own factory.
export interface NewQueuedIngestInput {
  id: string;
  tenant: string;
  requested?: number; // the ingested trace count — the ask of an ingest batch
  dataset: { id: string; version: string };
  harness: { id: string; version: string }; // the harness that produced the trace (label)
  origin?: ScorecardOrigin;
  createdBy?: string;
  teamId?: string; // owning team — an ingested batch is a team's result too, so it is not born unowned
  now: string;
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
): DomainFact[] {
  const { dataset, harness } = batchLabels(record);
  // passRate from the summary this terminal write persists (extras wins; a bare failure keeps the record's) —
  // the pointer an agent trigger can filter on (`passRate < 1`) without re-reading the full results.
  // DECISION-shaped (arch-review 8 P1): the stamped VerdictPolicy's aggregate when the record carries one,
  // and only then the authority-ranked headline. A workspace with a composed policy had UI and release
  // reading the verdict aggregate while the EVENT carried a metric-ranked rate the policy ranks differently
  // — and an owner-agent takes the event as fact. "scorecard.completed passRate=1" while the stamped verdict
  // says the batch failed is the exact shape of a wrong autonomous decision. One number, one authority.
  const summary = extras.summary ?? record.summary;
  const verdictSummary = extras.verdictSummary ?? record.verdictSummary;
  const trialSummary = record.trialSummary;
  const passRate =
    decisionPassRate({
      ...(verdictSummary ? { verdictSummary } : {}),
      ...(trialSummary ? { trialSummary } : {}),
      ...(summary ? { summary } : {}),
    }) ?? undefined;
  return [
    {
      kind: status === "succeeded" ? "scorecard.completed" : "scorecard.failed",
      subject: { type: "scorecard", id: record.id },
      ...(record.createdBy !== undefined ? { actor: record.createdBy } : {}),
      payload: {
        status,
        dataset,
        harness,
        ...(passRate !== undefined ? { passRate } : {}),
        ...(record.origin?.source !== undefined ? { origin: record.origin.source } : {}),
      },
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
      ...(input.requested !== undefined ? { requested: input.requested } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  // The only place a queued ingest scorecard is assembled (push and pull share the shape).
  static newQueuedIngest(input: NewQueuedIngestInput): ScorecardRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      ...(input.requested !== undefined ? { requested: input.requested } : {}),
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
  static creationFacts(record: ScorecardRecord, cases: number): DomainFact[] {
    const { dataset, harness } = batchLabels(record);
    return [
      {
        kind: "scorecard.submitted",
        subject: { type: "scorecard", id: record.id },
        ...(record.createdBy !== undefined ? { actor: record.createdBy } : {}),
        payload: {
          status: record.status,
          dataset,
          harness,
          cases,
          ...(record.origin?.source !== undefined ? { origin: record.origin.source } : {}),
          ...(record.origin?.scheduleId !== undefined ? { scheduleId: record.origin.scheduleId } : {}),
        },
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

  // ── WHICH CHILD IS THE CASE'S ANSWER (review 39 P0, Phase 4) ───────────────────────────────────────
  //
  // The receipt, and nothing else. `latestChildPerCase` — the largest `updatedAt` — answered "which row was
  // touched last" over rows that are all equally real, so a late metadata write on a superseded attempt could
  // change a settled batch's canonical result after the fact. It survived one review as a per-case fallback;
  // it is gone now, because a fallback that decides correctness is not a fallback, it is a second answer.
  //
  // A case with no receipt therefore has NO canonical child — which is exactly what the caller's missing-case
  // check is for. That is self-healing rather than lossy: an unaccounted case fails the batch into a state
  // recovery picks up, the re-drive commits a receipt, and the batch finalizes on the second pass. A batch
  // that predates receipts entirely is already terminal, and nothing re-finalizes a terminal batch.
  //
  // Keyed by the (case, trial) CHILD KEY — the axis the receipt's primary key already carries. Keying by
  // caseId alone collapsed a trialled case's N receipts into one map slot, which is why every consumer used
  // to abandon the ledger for a trialled batch: the aggregation dropped the axis the schema kept.
  static canonicalChildPerCase(
    children: RunRecord[],
    receipts: ReadonlyArray<{ caseId: string; trial: number; childRunId: string }>,
  ): Map<string, RunRecord> {
    const byId = new Map(children.map((c) => [c.id, c]));
    const canonical = new Map<string, RunRecord>();
    for (const receipt of receipts) {
      const committed = byId.get(receipt.childRunId);
      // A receipt naming a child this batch cannot see is a disagreement the caller states (the parity
      // check) — never a licence to pick some other row and call it the answer.
      if (committed) canonical.set(childKey(receipt.caseId, receipt.trial), committed);
    }
    return canonical;
  }

  // ── THE SETTLE'S FROZEN READ-SET (review 40, the Release pattern) ──────────────────────────────────
  //
  // Pure over the receipts the settle read: one row per (case, trial) naming the committed child, the digest
  // of the counted bytes and the attempt that produced them, plus the COUNT the terminal write conditions on
  // (receipts are insert-only — a receipt landing between the read and the write refuses the settle). Sorted
  // so the set digest is an identity, not an ordering accident.
  static decisionContext(
    receipts: ReadonlyArray<{
      caseId: string;
      trial: number;
      childRunId: string;
      resultDigest: string;
      attemptId?: string;
    }>,
    epoch?: number,
    // The plan's own (caseId, trial) set — when the caller carries it, the context records its digest so the
    // settle's completeness claim ("these receipts are exactly the plan") is auditable, not just enforced.
    expected?: ReadonlyArray<{ caseId: string; trial: number }>,
    // The judgment revision the settle's digests were taken over (initial settle = 1).
    scoringRevision?: number,
  ): ScorecardDecisionContext {
    const cases = [...receipts]
      .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : a.trial - b.trial))
      .map((r) => ({
        caseId: r.caseId,
        trial: r.trial,
        childRunId: r.childRunId,
        resultDigest: r.resultDigest,
        ...(r.attemptId !== undefined ? { attemptId: r.attemptId } : {}),
      }));
    return {
      ...(epoch !== undefined ? { epoch } : {}),
      receiptCount: receipts.length,
      receiptSetDigest: contentDigest(cases),
      ...(expected !== undefined
        ? {
            expectedCaseSetDigest: contentDigest(ScorecardBatch.sortedCaseSet(expected)),
            expectedCaseCount: expected.length,
          }
        : {}),
      ...(scoringRevision !== undefined ? { scoringRevision } : {}),
      cases,
    };
  }

  private static sortedCaseSet(
    pairs: ReadonlyArray<{ caseId: string; trial: number }>,
  ): Array<{ caseId: string; trial: number }> {
    return [...pairs]
      .map((p) => ({ caseId: p.caseId, trial: p.trial }))
      .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : a.trial - b.trial));
  }

  // ── EXPECTED SET == OUTCOME SET, EXACTLY (arch-review 41 P1) ────────────────────────────────────────
  //
  // The receipt gate holds every COUNTED case to a receipt; nothing held the receipt set to the PLAN. A case
  // that never entered any process's memory was invisible to both, and an extra receipt (a case the plan
  // never asked for) was silently summarized. Pure over the two sets, on the (caseId, trial) axis the
  // receipt's own key carries — the trial dimension included, which the id-only check dropped.
  static caseSetDelta(
    expected: ReadonlyArray<{ caseId: string; trial: number }>,
    receipts: ReadonlyArray<{ caseId: string; trial: number }>,
  ): { missing: string[]; extra: string[] } {
    const want = new Set(expected.map((p) => childKey(p.caseId, p.trial)));
    const have = new Set(receipts.map((r) => childKey(r.caseId, r.trial)));
    return {
      missing: [...want].filter((k) => !have.has(k)).sort(),
      extra: [...have].filter((k) => !want.has(k)).sort(),
    };
  }

  // Terminal = the batch's outcome is settled; nothing may rewrite it (first terminal write wins).
  isTerminal(): boolean {
    return (TERMINAL_SCORECARD_STATUSES as readonly string[]).includes(this.record.status);
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
  // Derived on read means derived under a POLICY, so it resolves this record's own stamp; a batch whose
  // stamped policy cannot be restored gets no roll-up at all (the headline pass rate reads passAt1 first —
  // a number re-judged under today's ladder would headline as this batch's history).
  withTrialSummary(): ScorecardRecord {
    const sc = this.record.scorecard;
    if (!sc || this.record.trialSummary || !sc.results.some((r) => r.trial !== undefined)) return this.record;
    const resolution = resolvePolicyResolution(this.record.verdictPolicy, this.record.manifest?.verdictPolicy);
    if (resolution.status === "unresolvable") return this.record;
    return { ...this.record, trialSummary: summarizeTrials(sc, { policy: resolution.policy }) };
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
      patch: { status: "succeeded", ...extras, ...judgedUnder(this.record.manifest?.verdictPolicy), updatedAt: now },
      facts: batchTerminalFact(this.record, "succeeded", extras),
    };
  }

  // queued|running → failed (a pipeline-phase error; partial results ride along for visibility).
  fail(error: ScorecardRunError, extras: ScorecardOutcomeExtras, now: string): ScorecardTransition {
    this.assertNotTerminal("fail");
    return {
      patch: {
        status: "failed",
        error,
        ...extras,
        ...judgedUnder(this.record.manifest?.verdictPolicy),
        updatedAt: now,
      },
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
          ...(this.record.createdBy !== undefined ? { actor: this.record.createdBy } : {}),
          payload: { status: "cancelled", dataset, harness },
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
    // Decision-shaped, same rule as batchTerminalFact: a re-score REWRITES the verdict aggregate, so the fact
    // announcing it must carry the new aggregate's rate — not a metric ranking the stamped policy may order
    // differently. This is the number an owner-agent reacts to.
    const verdictSummary = extras.verdictSummary ?? this.record.verdictSummary;
    const trialSummary = this.record.trialSummary;
    const passRate =
      decisionPassRate({
        ...(verdictSummary ? { verdictSummary } : {}),
        ...(trialSummary ? { trialSummary } : {}),
        ...(summary ? { summary } : {}),
      }) ?? undefined;
    // The scoring revision this pass appended (when the service supplied the ledger) — the fact names WHICH
    // judgment era begins here, so a consumer can correlate it with gate pins without re-reading the record.
    const revision = extras.scoring?.at(-1)?.revision;
    return {
      patch: { ...(promoted ? { kind: "scorecard" as const } : {}), ...extras, updatedAt: now },
      facts: [
        {
          kind: "scorecard.scored",
          subject: { type: "scorecard", id: this.record.id },
          ...(by.actor !== undefined ? { actor: by.actor } : {}),
          payload: {
            status: this.record.status,
            dataset,
            harness,
            ...(passRate !== undefined ? { passRate } : {}),
            ...(promoted ? { promoted: true } : {}),
            ...(revision !== undefined ? { revision } : {}),
          },
        },
      ],
    };
  }

  // The track loop settling an aborted batch (supersede OR user cancel): attach whatever partial outcome exists
  // (results that fired, partial export, the failure that surfaced mid-abort) while KEEPING the aborted status.
  // Legal over a record already marked superseded/cancelled (the abort writes the status first, then aborts the
  // loop — the settlement PRESERVES it) — but never over a batch that settled as succeeded/failed.
  // May an aborted track loop still attach its partials? Legal over queued/running/cancelled/superseded —
  // NEVER over a batch that settled succeeded/failed (first terminal write wins; the winner's outcome is
  // not amended by a reclaimed driver's leftovers). The guard is the SSOT; settleAborted throws on the same
  // condition so a caller that skipped the question still cannot land the write (arch-review 42: the
  // in-process abort branch asked nothing, and the refusal surfaced as an unhandled rejection).
  canSettleAborted(): boolean {
    return this.record.status !== "succeeded" && this.record.status !== "failed";
  }

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
