import {
  AppError,
  AuthorityLostError,
  type CaseCommitReceipt,
  type CaseJob,
  type CaseResult,
  ConflictError,
  type Dataset,
  type HarnessSpec,
  InternalError,
  type JudgeRunConfig,
  type RunRecord,
  type Scorecard,
  type ScorecardStep,
  type Suite,
  type VerdictPolicy,
  attemptIdOf,
} from "@everdict/contracts";
import {
  type CircuitBreaker,
  Run,
  ScorecardBatch,
  type ScorecardOutcomeExtras,
  billingCharges,
  caseResultDigest,
  caseVerdict,
  modelBindingLabel,
  newScorecardChildRun,
  runEvidenceIdentity,
  scorecardModels,
  summarizeScorecard,
} from "@everdict/domain";
import {
  appendScoringRevision,
  caseReason,
  childKey,
  inputObservationOf,
  verdictSummaryOf,
  worldCohortOf,
} from "@everdict/domain";
import { jobAttemptId, openPhysicalAttempt } from "../execution/open-physical-attempt.js";
import type { ScoringService, SealedJudgeClosure } from "../execution/scoring-service.js";
import { AdaptiveConcurrencyGate } from "../ops/adaptive-concurrency.js";
import { weightedTargets } from "../ops/shard-weights.js";
import { SpeculationController } from "../ops/speculation.js";
import type { DriverAuthority } from "../ops/startup-recovery.js";
import { stampFacts } from "../platform-event/outbox.js";
import { settleScorecard } from "../ports/settle.js";
import { sealExecutionPlanes } from "../ports/trajectory-store.js";
import type { Dispatch } from "../run-suite.js";
import { runSuite } from "../run-suite.js";
import type { BatchDriverShared } from "./batch-driver-shared.js";
import type { CaseOutcomeCommitter, FailureFinalization, PendingChildSettle } from "./case-outcome-committer.js";
import { ExecutionPlan } from "./execution-plan.js";
import { type PublicationOutcome, drainPublication, planPublication } from "./publication.js";
import type { ResilientCaseRunner } from "./resilient-case-runner.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";
import {
  analysisBundle,
  batchSettledEvent,
  exportStepMessage,
  initialPassId,
  offloadResults,
  stageAnalysis,
} from "./scorecard-observability.js";

// The correlation id a case is DISPATCHED with — the key its frames, logs, live trajectory and replay are
// written under. One function, so the id the job carries and the id the child row stamps cannot drift.
function executionIdOf(job: { evalCase: { id: string }; trial?: number; batchId?: string }, batchId?: string): string {
  const parent = job.batchId ?? batchId ?? "";
  return `evd-${parent}-${job.evalCase.id}${job.trial !== undefined ? `-t${job.trial}` : ""}`;
}

// Re-drive support (docs/architecture/batch-resilience.md):
//  seed        — finished CaseResults carried in verbatim (restart resume: done children · retry-failed: source passes).
//                Seeded cases are NOT re-dispatched, re-judged, or re-exported; they merge into the final scorecard.
//  seedRunIds  — the child-run ids behind the seeds (kept in record.runIds so get() hydration still sees every case).
//  retries     — transient dispatch retries per case (throw-only).
//  resumeNote  — a timeline step explaining why this track run starts mid-way.
//  trials      — run each case N times (pass@k / flakiness); one child run per (case, trial). Default 1.
export interface TrackOptions {
  seed?: CaseResult[];
  seedRunIds?: string[];
  retries?: number;
  resumeNote?: string;
  trials?: number;
  // OOM escalation (retry-failed) — per-case memoryMb override applied to the job's harnessSpec at dispatch.
  memoryBoostMb?: Record<string, number>;
  // Per-batch trace-sink override (orchestration.traceSink) — threaded into the export context.
  sinkOverride?: string;
  // In-batch OOM auto-boost (orchestration.oomAutoBoost) — see oom-boost.ts.
  oomAutoBoost?: boolean;
  // The batch's composed verdict policy (manifest.verdictPolicy) — absent = the built-in ladder. Live
  // per-case verdicts and the settle-time derivations are decided by it, so what a member watches during
  // the batch is what the settled record stamps.
  verdictPolicy?: VerdictPolicy;
  // The submit-time judge closure (manifest.judges) — the judge stream concretizes its moving refs to
  // THIS resolution, so the seal is the pin instead of a second resolution's observation (I6).
  sealedJudges?: SealedJudgeClosure[];
  // The manifest's model DOCUMENT pins, carried onto every job this loop dispatches (arch-review 20 P0-2).
  modelPins?: CaseJob["modelPins"];
  // THE FENCING TOKEN THIS LOOP WAS HANDED (arch-review 32 P0), from the claim that won it. Absent = a
  // submit, which drives under the epoch the record was created with. What must never happen is this
  // loop deciding its own authority by reading the row — see the note where it is consumed.
  authority?: DriverAuthority;
}

// The one batch this driver was created for — the arguments the facade's `track` has always taken, as an
// object, because they are now handed to a constructor instead of pushed onto a call stack.
export interface InProcessBatchInputs {
  id: string;
  tenant: string;
  owner: string; // submitter subject — for resolving private-repo case tokens (personally-owned connection)
  dataset: Dataset;
  harnessId: string;
  harnessVersion: string;
  harnessSpec: HarnessSpec | undefined;
  judges: Array<{ id: string; version: string }>;
  runtime: string | undefined;
  judge: JudgeRunConfig | undefined;
  concurrency: number; // number of cases to dispatch concurrently (request override→service default is resolved in submit).
  opts: TrackOptions;
}

// ── ONE INSTANCE, ONE BATCH (arch-review 34) ─────────────────────────────────────────────────────────
//
// The in-process driver: the fan-out loop that dispatches a batch's cases from THIS process, judges them as
// they land, and settles the parent. It lives in its own object rather than as a method on the facade
// because the loop's bookkeeping is per-batch — the pending child settles, the per-execution attempt
// numbers, the cases a failure exit already finalized — and a service field is how that state leaks from
// one batch into the next (the cross-batch pending map arch-review 34 found). An instance is created for a
// single batch and `run()` is called once, so every one of those maps stays a LOCAL of `run()`: there is no
// field for a second batch to share, and the driver is garbage after its batch ends.
export class InProcessBatchDriver {
  private readonly commit: CaseOutcomeCommitter;
  private readonly scoring: ScoringService;
  private readonly breaker: CircuitBreaker;
  private readonly inFlight: Map<string, AbortController>;
  private readonly cases: ResilientCaseRunner;
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(
    private readonly deps: ScorecardBatchDeps,
    private readonly shared: BatchDriverShared,
    private readonly input: InProcessBatchInputs,
  ) {
    this.commit = shared.commit;
    this.scoring = shared.scoring;
    this.breaker = shared.breaker;
    this.inFlight = shared.inFlight;
    this.cases = shared.cases;
    this.newId = shared.newId;
    this.now = shared.now;
  }

  // The batch driver loop, verbatim from the facade's former `track` — the arguments it used to take are
  // destructured off this instance's inputs, so the body below reads exactly as it did as a method.
  async run(): Promise<void> {
    const {
      id,
      tenant,
      owner,
      dataset,
      harnessId,
      harnessVersion,
      harnessSpec,
      judges,
      runtime,
      judge,
      concurrency,
      opts,
    } = this.input;
    const trials = opts.trials ?? 1;
    // If supersede already reclaimed this batch (or it otherwise settled), don't start — never revive a
    // terminal record back to running.
    const opening = await this.deps.store.get(id);
    if (!opening) return;
    const openingBatch = ScorecardBatch.from(opening);
    if (openingBatch.isTerminal()) return;
    // THE DRIVER'S FENCING TOKEN (mig 0166). Owner identity elects a driver and does not fence the previous
    // one: a replica that paused past the liveness threshold comes back with THIS loop still running, and the
    // database saying somebody else owns the batch never reaches it. So the loop carries the epoch it began
    // under and proves it on the writes that drive the batch — a takeover raises the number, and the stale
    // driver's next write fails against a value that moved under it.
    //
    // ABSENT IS ZERO, NOT "UNFENCED" (arch-review 31 P1). The first version treated a record with no epoch as
    // a batch nobody may fence, reasoning that inventing a token would strand a single-replica install. It
    // strands nothing — a claim computes `epoch + 1` from that same absent value, so a driver holding 0 is
    // fenced by the very first takeover, and a batch nobody claims stays at 0 and settles exactly as before.
    // What the concession actually did was exempt EVERY batch submitted before a claim, which is all of them:
    // the loop held `undefined`, `proveAuthority` returned true without asking, and a displaced driver ran
    // the whole fan-out. The certification that covered this proved the store's CAS and never the loop.
    // CARRIED, NOT RE-READ (arch-review 32 P0). The row's current epoch is the wrong answer for a driver
    // that has been away: three replicas are enough to show it. B claims (epoch 1) and pauses; C claims
    // (epoch 2) and starts driving; B wakes, reads the row, adopts C's token as its own and drives beside it
    // — no race won, nothing overwritten, just a number read. A fencing token that can be looked up is not a
    // token, so the only value trusted here is the one the claim handed over.
    //
    // Absent = a submit rather than a recovery: this process created the record, so the epoch it was created
    // with IS the one it holds.
    // Cases whose execution finished and whose child is deliberately still OPEN until its judges land —
    // keyed by (caseId, trial), which is unique WITHIN a batch and nowhere else (arch-review 34 P0).
    const pendingChildSettle = new Map<string, PendingChildSettle>();
    // The recording ATTEMPT each case is running under (mig 0173), by execution id. A case's dispatch opens
    // one: `reset` clears whatever an earlier attempt of the same execution id left and returns the number
    // this one owns, which every producer reporting through this control plane then stamps. Without it a
    // scorecard re-drive was the one path where a returning producer still wrote into its successor's
    // recording — the standalone run had been given this and the batch had not.
    const attemptGeneration = new Map<string, number>();
    // …and the PHYSICAL ATTEMPT's ledger id (arch-review 42), which exists even when the generation does not:
    // a dispatch whose recording claim was refused still ran, and the row that says so is the whole point.
    const attemptLedgerId = new Map<string, string>();
    // Cases whose recording could not be ISOLATED for this attempt — the fence read or the reset failed. They
    // execute; their replay is simply not claimed as this attempt's, because the buffer may still hold an
    // earlier one's frames and nothing here can tell.
    const unisolated = new Set<string>();
    // Cases this loop finalized down the FAILURE exit — see FailureFinalization. The judged exit consults it
    // so a case that ended one way is not later reported as taken by somebody else, and commits its receipt.
    const finalizedByFailure = new Map<string, FailureFinalization>();
    const epoch = opts.authority?.epoch ?? opening.ownerEpoch ?? 0;
    const fenced = { expectOwnerEpoch: epoch };
    const epochOpt = { epoch };
    // Register the cooperative-cancellation handle — when supersedeInFlight aborts, runSuite stops firing remaining cases.
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    // A NON-TERMINAL CAS LOSER MUST TERMINATE ITS DOWNSTREAM AUTHORITY TOO (arch-review 31 P1). This write's
    // answer used to be dropped, and the gap it left needs no second replica to open: a cancel that lands
    // between the read above and this line settles the batch and calls `stopInFlight` before the controller
    // was registered, so nothing aborts it — and this loop then went on to dispatch cases for a batch the
    // user had already stopped. The row itself stays honest (every settle is fenced), but "cancel means stop
    // new work" is an execution promise, not a bookkeeping one.
    const started = await this.deps.store.update(id, openingBatch.start(this.now()).patch, undefined, {
      expectNonTerminal: true,
      ...fenced,
    });
    if (started === undefined) {
      controller.abort(); // whoever settled it owns this batch's ending; nothing here is ours to dispatch
      this.inFlight.delete(id);
      return;
    }
    // Progress (step) timeline — append as the run proceeds + persist incrementally so the web shows "how far / what" it's doing.
    const steps: ScorecardStep[] = [];
    const pushStep = (p: string, status: ScorecardStep["status"], message: string, caseId?: string): void => {
      steps.push({ ts: this.now(), phase: p, status, message, ...(caseId ? { caseId } : {}) });
    };
    const flushSteps = (): Promise<unknown> => this.deps.store.update(id, { steps: [...steps], updatedAt: this.now() });
    // "No online runner" placement warnings surfaced by the dispatcher at park time (self-hosted cases whose runner
    // pool is offline). Deduped by the exact reason (pool-level, case-independent) so an all-offline 601-case batch
    // shows ONE actionable line, not 601 identical steps. Non-terminal — the batch still runs the moment a runner
    // reconnects. Cleared implicitly by the batch finishing; a different reason (a different offline pool) re-shows.
    const waitingReasonsShown = new Set<string>();
    const onWaiting = (reason: string): void => {
      if (waitingReasonsShown.has(reason)) return;
      waitingReasonsShown.add(reason);
      pushStep("dispatch", "info", reason);
      void flushSteps();
    };
    const seed = opts.seed ?? [];
    const seedRunIds = opts.seedRunIds ?? [];
    // Seeds carried WITHOUT child-run backing (retry-failed carries another scorecard's results) can't be
    // hydrated from this batch's children — those batches embed the full scorecard alongside runIds.
    const seedChildBacked = seedRunIds.length >= seed.length;
    // WHAT A RE-DRIVE ALREADY HAS AN ANSWER FOR, ON THE TRIAL AXIS (arch-review 52, wave 1). A seed is one
    // committed (case, trial) execution — the receipt ledger's own unit — so the exclusion is stated in that
    // unit. Reducing it to a case id gave a trialled resume only two wrong choices: skip the whole case (and
    // lose the trials that never committed) or re-run it (and pay for the ones that did). It is why a
    // multi-trial batch was refused a faithful resume at all.
    const seededKeys = new Set(seed.map((r) => childKey(r.caseId, r.trial)));
    // A case leaves the dispatch list only when EVERY one of its trials is already answered. At trials=1 this
    // is the old case-level test exactly (one trial per case), so the single-run path is unchanged.
    const fullySeededIds = new Set(
      dataset.cases
        .filter((c) =>
          Array.from({ length: trials }, (_, t) => childKey(c.id, trials > 1 ? t : 0)).every((k) => seededKeys.has(k)),
        )
        .map((c) => c.id),
    );
    if (opts.resumeNote) pushStep("resume", "info", opts.resumeNote);
    // Child runs this batch fanned out: caseId → childId (when runStore is set). Used after completion for the final write-back + storing runIds references.
    const caseToChild = new Map<string, string>();
    // Once per batch: shared + submitter (owner) personal secret maps (if any). Just before dispatching a case, resolve {secretRef} in the harness env by scope
    // — no plaintext remains in the registry spec; it's injected only at run time. If a referenced secret is missing, that case fails with a clear reason.
    const secretMap =
      harnessSpec && this.deps.scopedSecretsFor ? await this.deps.scopedSecretsFor(tenant, owner) : undefined;
    // Shard list (comma-separated runtime list) — computed up front because the dispatch closure needs it for
    // runtime spillover (a retryable infra failure moves the case to the next healthy runtime in this list).
    const targets = runtime
      ? runtime
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    // Tail speculation (assigned once the case count is known, below) — the dispatch closure captures the binding.
    let speculation: SpeculationController | undefined;
    // Per-case dispatch (orchestration per case): admit (per-case since it's a batch) → enrich the job → pure executeCase → settle.
    // The pure execution (token resolve+attach → dispatch) is handled by executeCase (shared with a single run); settlement/child-run lifecycle is handled by the orchestration here.
    // When runStore is set, create a child run (RunRecord) per case so each case becomes an addressable run (trace/usage/provenance).
    // The batch's structured WHY, computed once and carried onto every fan-out child (P0). One extra read
    // per batch; the record was created before track() is called, so a miss only means "no origin stamp".
    const batchForOrigin = await this.deps.store.get(id);
    const childOrigin = batchForOrigin ? ScorecardBatch.childRunOrigin(batchForOrigin) : undefined;
    const childEnv = batchForOrigin ? await this.shared.childEnvelope(batchForOrigin) : undefined; // §5.2, once per batch
    const dispatch: Dispatch = async (job) => {
      this.deps.budget?.admit(tenant); // throws if over budget → batch fails
      // AUTHORITY BEFORE EFFECT (arch-review 30 P0). A fencing token on the RECORD is not a fencing token on
      // the EFFECT: a replica that paused past the liveness threshold comes back with this loop intact, and
      // its writes being refused says nothing about the compute it is about to spend. So the epoch is proven
      // BEFORE each case leaves — a takeover raises the number, this write fails against it, and the whole
      // fan-out aborts rather than dispatching one more case it no longer owns.
      //
      // What this closes and what it does not, said plainly: the window between this proof and the dispatch
      // below is small and real. Closing it entirely needs the dispatch intent itself to commit under the
      // epoch (the scoring plane's child-write fence is the pattern), which is a deeper change than a guard.
      // A driver that loses the token here stops within one case instead of running the batch to completion.
      if (!(await this.proveAuthority(id, fenced, controller)))
        // Thrown rather than returned: the callback owes a CaseResult, and inventing one would be this loop
        // reporting an outcome for work it did not do. run-suite isolates the throw, the abort above stops
        // the sibling lanes, and every settle this driver could still attempt is fenced on the same epoch —
        // so nothing it writes from here lands.
        throw new ConflictError(
          "CONFLICT",
          { scorecard: id },
          "this replica no longer owns the batch — another one claimed it while this loop was running, so the case was not dispatched.",
        );
      // A RETRY REOPENS THE CASE (review 40). runSuite re-dispatches a retryable throw, and the previous
      // attempt's failure exit had already marked the case finalized — so the judged exit would meet the
      // retried SUCCESS, read "already ended", and skip settling its child entirely: a stuck running row
      // under a batch that reports the case done. A new dispatch of the same (case, trial) is a new attempt,
      // and the failure bookkeeping of the old one does not describe it.
      //
      // …and the superseded attempt's child is abandoned HERE (arch-review 41 P0-lifecycle), because this is
      // where "that child is not the answer" becomes a fact: the failure exit no longer terminalizes (the
      // failure might not have been final — this very re-dispatch is the proof), so the abandoned attempt's
      // open row is fail-settled now, fenced, with the error the catch recorded. No receipt: a superseded
      // attempt was never the case's answer.
      const reopened = finalizedByFailure.get(childKey(job.evalCase.id, job.trial));
      if (reopened !== undefined) {
        // The abandoned attempt reaches its terminal state on the physical ledger too (arch-review 42):
        // SUPERSEDED, not failed — the failure was not final (this re-dispatch is the proof), so what the
        // ledger records is that this execution stopped being the case's, carrying the error that ended it.
        // Stamped even when the attempt had no child row: a physical execution happened either way.
        await this.commit.stampAttempt(
          // Named by the failure record itself when it carries one (arch-review 51) — an unisolated attempt
          // has a row and no generation, so the derivation alone left exactly those rows non-terminal.
          reopened.attemptId ??
            (reopened.generation === undefined ? undefined : attemptIdOf(reopened.executionId, reopened.generation)),
          "superseded",
          { error: reopened.error },
        );
      }
      if (reopened?.childId !== undefined) {
        const abandonedChildId = reopened.childId;
        await this.commit
          .settleChild(
            abandonedChildId,
            (cur) => Run.from(cur).fail(reopened.error, this.now()).patch,
            reopened.parentDriver,
          )
          .catch(() => {});
      }
      finalizedByFailure.delete(childKey(job.evalCase.id, job.trial));
      const enriched: CaseJob = {
        ...job,
        tenant,
        batchId: id, // scheduler-side reclaim key (supersede / speculation-loser queue cancel)
        // Trace correlation, derivable by observers: evd-<batchId>-<caseId>[-t<n>] (live-observability).
        runId: executionIdOf(job, id),
        priority: "batch", // fan-out work — yields the queue to interactive single runs
        // owner (submitter subject) — self-hosted runner dispatch-ownership check + lease-queue key (same as a single run).
        ...(owner ? { submittedBy: owner } : {}),
        ...(harnessSpec ? { harnessSpec } : {}),
        // THE SAME PINS THE TEMPORAL PATH CARRIES (arch-review 20 P0-2). This one was left out, so the
        // guarantee depended on which driver a deployment happened to use: Temporal-driven batches refused a
        // shadowed model at dispatch and in-process ones — Temporal unconfigured, a failed workflow start, a
        // multi-trial batch, an inline dataset, some resumes — carried no pin for the dispatcher to check.
        // A guarantee is only as strong as its thinnest production adapter.
        ...(opts.modelPins ? { modelPins: opts.modelPins } : {}),
        ...(judge ? { judge } : {}),
      };
      const runStore = this.deps.runStore;
      let child: RunRecord | undefined;
      // ── AN ATTEMPT IS OPENED BY THE DISPATCH, NOT BY WHETHER ANYONE HAPPENED TO RECORD ──────────────
      //
      // This used to `peek` first and open a new attempt only when the buffer already held something. But the
      // existence of a PHYSICAL EXECUTION and the existence of a recording entry are not the same fact, and
      // the gap between them is the ordinary case: an attempt that has been dispatched but has not yet
      // emitted a frame or a log is invisible to `peek`. A recovery arriving in that window opened no new
      // attempt, so both executions wrote under the same generation and the fence they were both standing on
      // separated nothing. (The two adapters even disagreed about what an empty buffer looks like, which is
      // the same statement from the other side: the question was being asked of the wrong thing.)
      //
      // So the attempt opens HERE, unconditionally, because this is the moment a physical execution begins.
      // A first attempt therefore owns generation 1 rather than 0, and a producer that was never told a
      // number stamps 0 and is refused — which is the intended reading of "no attempt", not an exemption.
      // The number travels ON THE JOB from here (CaseJob.recordingGeneration), so no wiring can lose it.
      {
        const executionId = executionIdOf(job, id);
        // FAIL-CLOSED (arch-review 38 P0). An open that throws is not "isolation was unnecessary" — it is a
        // fence we could not raise. The case still RUNS (the evaluation is what the user asked for), knowing
        // its replay is not canonical, which is what `unisolated` records.
        const attempt = await openPhysicalAttempt(
          { attempts: this.deps.attempts, recordings: this.deps.recordingStore },
          {
            executionId,
            tenant,
            scorecardId: id,
            caseId: job.evalCase.id,
            ...(job.trial !== undefined ? { trial: job.trial } : {}),
            driverEpoch: epoch,
          },
        );
        if (attempt.unisolated) unisolated.add(executionId);
        if (attempt.generation !== undefined) attemptGeneration.set(executionId, attempt.generation);
        if (attempt.attemptId !== undefined) attemptLedgerId.set(executionId, attempt.attemptId);
      }
      try {
        // Child run (if any): born queued, flipped to running via onStarted only when compute actually starts
        // (a runner leases it / a managed backend dispatches it). Tagged with parentScorecardId, hidden from
        // the activity list by default. INSIDE the failure exit's reach (review 40): a create that throws is a
        // store fault, and it must leave by the same finalization bookkeeping as any other dispatch failure —
        // outside it, the judged exit later read "somebody else took this case" about a case nobody took, and
        // that answer aborts the whole batch (the arch-review 38 P1 shape, one line earlier).
        if (runStore) {
          child = newScorecardChildRun({
            id: this.newId(),
            tenant,
            harness: { id: harnessId, version: harnessVersion },
            caseId: job.evalCase.id,
            parentScorecardId: id,
            // The id its evidence will be keyed by, stamped rather than left to be re-derived (mig 0172) —
            // the derivation drops the trial, and a trialled case has one child per trial.
            executionId: executionIdOf(job, id),
            ...(runtime ? { runtime } : {}), // propagate the batch's runtime to the child too — the queue's runtime-lane axis
            ...(childOrigin ? { origin: childOrigin } : {}),
            ...(childEnv ? { envelope: childEnv } : {}),
            now: this.now(),
          });
          // …and the in-process loop commits the same intent under the epoch IT holds (P1 above).
          await runStore.create(child, undefined, { parentDriver: { scorecardId: id, epoch } });
          caseToChild.set(childKey(job.evalCase.id, job.trial), child.id);
        }
        // Resolve env secret references (just before dispatch). If a referenced secret is missing, resolveHarnessSecrets throws → this case is isolated as a failure.
        const childId = child?.id;
        // The attempt opened above travels WITH the job (review 39 P0-1), so a producer in another process
        // stamps the generation IT was leased rather than whatever the receiving process last heard about.
        const openedGeneration = attemptGeneration.get(executionIdOf(job, id));
        const openedAttemptId = attemptLedgerId.get(executionIdOf(job, id));
        const dispatchable: CaseJob = {
          ...enriched,
          ...(openedGeneration !== undefined ? { recordingGeneration: openedGeneration } : {}),
          // …and the ledger row this dispatch opened, by name (arch-review 51) — present even when the
          // recording claim was refused, which is what makes an unisolated attempt addressable and what lets
          // a self-hosted park record which attempt it parked (runner_jobs.current_attempt_id).
          ...(openedAttemptId !== undefined ? { attemptId: openedAttemptId } : {}),
        };
        const reattempt = this.cases.reattemptOf({
          tenant,
          scorecardId: id,
          driverEpoch: epoch,
          // Every spill/boost this case makes moves the lane's idea of "the current attempt" (arch-review
          // 51) — so the failure exit below records the attempt that actually failed, not the first one.
          onOpen: (execution, opened) => {
            if (opened.generation !== undefined) attemptGeneration.set(execution, opened.generation);
            if (opened.attemptId !== undefined) attemptLedgerId.set(execution, opened.attemptId);
            if (opened.unisolated) unisolated.add(execution);
          },
        });
        const {
          result,
          target: ranOn,
          job: winnerJob,
        } = await this.cases.run(dispatchable, {
          owner,
          targets,
          tenant,
          secretMap,
          boostMb: opts.memoryBoostMb?.[job.evalCase.id],
          oomAutoBoost: opts.oomAutoBoost,
          speculation,
          ...(reattempt ? { reattempt } : {}),
          onWaiting,
          // COMPUTE ACTUALLY STARTED — the same pair the Temporal driver stamps: the child flips
          // queued→running, and the attempt ledger records that this execution reached the machine. Keyed
          // to the STARTED job (arch-review 51 residue): after a spill/OOM reattempt the dispatch-time
          // capture named the abandoned attempt, not the one that reached the machine.
          // WHERE THIS CASE'S COMPUTE IS (arch-review 52, Wave 2) — persisted the moment the backend creates
          // it, so a cancel that outlives this process stops THAT job. The handle names its own attempt (it
          // carries the dispatched job's attemptId), which is what makes it correct under spillover and
          // speculation: those dispatch several attempts, and each reports its own.
          // Awaited: the ledger holds the handle before the cluster holds the job (arch-review 53, Wave A).
          onReserved: (work) => this.commit.stampWork(work),
          onStarted: (startedJob) => {
            const started = startedJob.runId !== undefined ? jobAttemptId(startedJob, startedJob.runId) : undefined;
            void this.commit.stampAttempt(started ?? openedAttemptId, "executing", {
              ...(childId ? { childRunId: childId } : {}),
            });
            if (childId && runStore) void this.commit.markChildRunning(childId);
          },
          onStep: (message, cid) => {
            pushStep("case", "info", message, cid);
            void flushSteps();
          },
        });
        // Cost attribution: managed=batch tenant · workspace-shared runner=that workspace (team resource) · personal runner=own-pays. Same as a single run.
        // Bill the case, itemized per model (same as a single run): managed/ws-runner bill the whole cost; an own-pays
        // personal self-hosted run bills the workspace only for calls on a workspace-billed model. Meter + budget together.
        let caseUsd = 0;
        for (const c of billingCharges(result, tenant)) {
          this.deps.budget?.settle(c.tenant, c.cost);
          this.deps.usage?.record(c.tenant, c.source, c.model, c.cost, c.evaluations);
          caseUsd += c.cost.usd;
        }
        // Envelope draw-down (§5.2 O7 meter): the full caused cost charges the delegating envelope.
        if (childEnv && caseUsd > 0) void this.deps.envelopes?.settle(childEnv.id, tenant, caseUsd);
        // …and the same question the Temporal path asks before it publishes anything (arch-review 33): a
        // driver displaced while this case ran does not plant its execution plane, because the child it
        // belongs to is about to be re-driven by somebody else and the FIRST seal is the permanent one.
        if (!(await this.shared.holdsBatch(id, epoch))) {
          controller.abort();
          throw new ConflictError(
            "CONFLICT",
            { scorecard: id, case: job.evalCase.id },
            "this replica no longer drives the batch — the case's evidence is not ours to publish",
          );
        }
        // P5 dual-write: the case's trajectory seals in the OWNED store under its child run id (idempotent).
        if (child && result.trace.length > 0)
          if (this.deps.trajectories)
            void sealExecutionPlanes(this.deps.trajectories, {
              runId: child.id,
              tenant,
              events: result.trace,
              // WHOSE evidence this is (review 39 P1): the attempt this dispatch opened, spelled the way the
              // receipt spells it, so a reader can compare rather than assume — the WINNING physical
              // attempt's generation (a spill/boost/duplicate opened its own), never the first dispatch's.
              // Only when KNOWN (arch-review 46): `?? 0` fabricated a coordinate no ledger mints.
              // …through the one reading that knows both halves (jobAttemptId, arch-review 51): an unisolated
              // winner carries its row's NAME and no generation, and named nothing here until it did.
              ...(() => {
                const named = jobAttemptId(winnerJob, executionIdOf(job, id));
                return named !== undefined ? { attemptId: named } : {};
              })(),
              ...runEvidenceIdentity(child),
              ...(result.traceT0 !== undefined ? { t0: result.traceT0 } : {}),
            }).catch(() => {});
        // A TERMINAL CHILD IS FINALIZED EVIDENCE, NOT A FINISHED EXECUTION (arch-review 33 P0).
        //
        // This used to settle the child `succeeded` right here, with the RAW execution result, while the
        // selected judges ran afterwards on the streaming path. A crash in between left a row that says
        // terminal AND carries a result — which is exactly the shape recovery reads as "finished evidence,
        // do not re-run and do not re-judge". The batch would then complete with a case that silently never
        // met a judge the manifest says was selected: no score, and no `unmeasured` row saying why. That is
        // a wrong VERDICT, arrived at without a single failed write.
        //
        // The Temporal driver already had it right (it awaits `applyJudges` before settling), so the same
        // recovery rule was reading two different meanings depending on which driver a deployment used. The
        // settle is now deferred to `onResult`, after the judges land — see `settleJudgedChild`.
        // Keyed by the JOB's (case, trial) — the same key `caseToChild` uses. Keying it by the harness RESULT
        // looked equivalent and was not: `runSuite` stamps the trial onto the result AFTER dispatch returns,
        // so all N trials of a case registered under `#0`, the first settle consumed the entry and the rest
        // read as somebody else's. A trialled case is N cases everywhere else in this file; here too.
        const winnerUnisolated = this.deps.recordingStore !== undefined && winnerJob.recordingGeneration === undefined;
        pendingChildSettle.set(childKey(job.evalCase.id, job.trial), {
          childId: child?.id,
          ...(ranOn ? { ranOn } : {}),
          parentDriver: { scorecardId: id, epoch },
          executionId: executionIdOf(job, id),
          ...(winnerJob.recordingGeneration !== undefined ? { generation: winnerJob.recordingGeneration } : {}),
          // …and the ledger row the commit must terminalize, by name (arch-review 51): with only the
          // generation, an unisolated attempt's row could not be addressed and stayed non-terminal for ever.
          ...(() => {
            const named = jobAttemptId(winnerJob, executionIdOf(job, id));
            return named !== undefined ? { attemptId: named } : {};
          })(),
          ...(unisolated.has(executionIdOf(job, id)) || winnerUnisolated ? { unisolated: true } : {}),
          judges, // …and what this batch asked of the case, so its commit can state a judge that never answered
          ...(opts.sealedJudges ? { sealedJudges: opts.sealedJudges } : {}),
        });
        return result;
      } catch (err) {
        // ── THE FAILURE EXIT TERMINALIZES NOTHING (arch-review 41 P0-lifecycle) ─────────────────────────
        //
        // It used to fail-settle the child right here and leave only the receipt for later — the exact
        // inverse of the commit point every other outcome uses. Two windows fell out of that order: a crash
        // between the terminal write and the receipt left a terminal child recovery reads as "uncommitted →
        // re-execute" (an orphan row forever), and a takeover in the window let the later RAW receipt claim
        // the case unfenced — canonicality decided by whichever insert arrived last, not by whichever
        // terminal transition won its fence. And a retryable throw made the settle actively wrong: the case
        // is about to be re-dispatched, so this attempt's child was being terminalized before anyone knew
        // whether the failure was final.
        //
        // So the catch only RECORDS: which child (still open), which attempt, what failed, under which
        // authority. The judged exit — where runSuite has frozen the failure as final — commits receipt +
        // fenced terminal write in ONE transaction (finalizeCaseAttempt), and a retry that re-opens the case
        // abandon-settles this attempt's child at the re-dispatch (where "not the answer" is actually known).
        const error =
          err instanceof AppError
            ? { code: err.code, message: err.message }
            : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
        // One case, one finalization, either exit (arch-review 38 P1): the judged exit meets the failed
        // result later — without this entry it reads "somebody else took this case" about one this very
        // loop just ended, and that answer aborts the whole batch.
        const finalizedKey = childKey(job.evalCase.id, job.trial);
        pendingChildSettle.delete(finalizedKey);
        const failedGeneration = attemptGeneration.get(executionIdOf(job, id));
        // The attempt that FAILED, by name — the last one this case opened (see the reattempt's onOpen), so a
        // case that spilled and then died terminalizes the execution that died rather than its predecessor,
        // which the supersede at re-dispatch had already ended (arch-review 51).
        const failedAttemptId = attemptLedgerId.get(executionIdOf(job, id));
        finalizedByFailure.set(finalizedKey, {
          ...(child !== undefined ? { childId: child.id } : {}),
          executionId: executionIdOf(job, id),
          ...(failedGeneration !== undefined ? { generation: failedGeneration } : {}),
          ...(failedAttemptId !== undefined ? { attemptId: failedAttemptId } : {}),
          parentDriver: { scorecardId: id, epoch },
          ...(unisolated.has(executionIdOf(job, id)) ? { unisolated: true } : {}),
          error,
          judges,
          ...(opts.sealedJudges ? { sealedJudges: opts.sealedJudges } : {}),
        });
        throw err; // rethrow so runSuite isolates the case (freezing it into a failed CaseResult)
      }
    };
    // On failure, diagnose "in which phase" — track the pipeline phase so catch records it as error.phase.
    let phase = "dispatch";
    let scorecard: Scorecard | undefined;
    try {
      // When a runtime is selected, inject it as each case's placement.target → RuntimeDispatcher routes to the tenant runtime.
      // A comma-separated list SHARDS the batch: cases round-robin across the listed runtimes (per-case placement,
      // per-case failure isolation unchanged) — one 601-case batch can drain a Nomad pool and a K8s pool at once.
      // Seeded cases (already-finished results carried in by resume/retry) are excluded from dispatch entirely.
      const casesToRun = seed.length > 0 ? dataset.cases.filter((c) => !fullySeededIds.has(c.id)) : dataset.cases;
      // History-weighted split: fast runtimes take proportionally more cases so the shards finish together
      // (speculation stays a safety net, not a scheduler). No history → the old uniform round-robin.
      const history =
        targets.length > 1
          ? await this.shared.shardHistory(tenant, harnessId, harnessVersion, targets)
          : { ratios: new Map<string, number>() };
      const assigned = weightedTargets(casesToRun.length, targets, history.ratios);
      const cases =
        targets.length > 0
          ? casesToRun.map((c, i) => ({
              ...c,
              placement: { ...c.placement, target: assigned[i] as string },
            }))
          : casesToRun;
      const suite: Suite = { id: dataset.id, harness: { id: harnessId }, cases };
      // Tail speculation — sharded batches only (single-runtime batches have nowhere to duplicate onto).
      if (targets.length > 1) {
        speculation = new SpeculationController({
          targets,
          tenant,
          breaker: this.breaker,
          totalCases: cases.length,
          ...(() => {
            const reattempt = this.cases.reattemptOf({
              tenant,
              scorecardId: id,
              driverEpoch: epoch,
              concurrent: true, // the duplicate races the primary — neither supersedes the other at open
            });
            return reattempt ? { reattempt } : {};
          })(),
          ...(history.seedMedianSec !== undefined ? { seedMedianMs: history.seedMedianSec * 1000 } : {}),
          onSpeculate: (cid, from, to) => {
            this.deps.onOrchestrationEvent?.({ kind: "speculation_fired", from, to });
            pushStep("case", "info", `${cid}: tail speculation ${from} ⇢ ${to} (straggler duplicate)`, cid);
            void flushSteps();
          },
          onWin: (_cid, _winner, speculated) => {
            if (speculated)
              this.deps.onOrchestrationEvent?.({ kind: "speculation_settled", winnerSpeculated: speculated });
          },
          onLoser: (outcome, cid) => this.shared.meterLostAttempt(tenant, outcome, cid, id),
          onLoserFailure: (lostJob, cid) => this.shared.stampLostBranch(lostJob, cid),
          ...(this.deps.cancelQueued
            ? {
                cancelQueued: (cid: string) =>
                  void this.deps.cancelQueued?.((j) => j.batchId === id && j.evalCase.id === cid),
              }
            : {}),
        });
      }
      // judge streaming — fire a case's judge the moment it finishes, without waiting for the whole batch to complete
      // (case-axis parallel·bounded). Removes the barrier where the slowest case blocked judging of the rest.
      // docs/architecture/streaming-case-pipeline.md
      // The child-run resolver lets each case's judge seal its own execution as a judge:<id> plane on that child —
      // caseToChild is filled at dispatch time, so it already holds the entry by the time onResult pushes the case.
      // The deferred child settles (P0 below): each one is queued behind its case's judges, and the batch may
      // not finalize until they have landed — a child still open when the write-back runs would be a row the
      // aggregate counts and the ledger calls unfinished.
      const childSettles: Array<Promise<"committed" | "lost" | "unwritten">> = [];
      const judgeStream = await this.scoring.createJudgeStream(
        tenant,
        dataset,
        judges,
        runtime,
        owner,
        (cid, trial) => caseToChild.get(childKey(cid, trial)),
        opts.sealedJudges,
        // …and each judge's own evidence plane seals only while this loop still holds the batch. Asked after
        // the judge call, because the judge call is where a takeover has time to happen (arch-review 34 P1).
        () => this.shared.holdsBatch(id, epoch),
      );
      // sink-export streaming (D5) — if the harness selected a sink, export each case to the team platform the moment it completes (after judging)
      // (live visibility + whatever went out survives even if the batch dies midway). If not wired,
      // the success path below falls back to exportResults (batched) (no regression).
      const exportCtx = {
        scorecardId: id,
        dataset: `${dataset.id}@${dataset.version}`,
        harness: `${harnessId}@${harnessVersion}`,
        // Judge attribution for the platform-side scores (judge id → declared model). Best-effort by contract:
        // attribution must never fail an export, so a resolution error degrades to the batch-identity fallback.
        judgeModels: await this.scoring.collectJudgeModelMap(tenant, judges).catch(() => ({})),
        ...(opts.sinkOverride ? { sinkOverride: opts.sinkOverride } : {}),
      };
      const exportStream = this.deps.exportStreamFor
        ? await this.deps.exportStreamFor(tenant, exportCtx).catch(() => undefined)
        : undefined;
      pushStep(
        "dispatch",
        "started",
        `Running ${cases.length} case(s)${trials > 1 ? ` × ${trials} trials` : ""}${seed.length > 0 ? ` (${seed.length} finished result(s) carried over)` : ""}`,
      );
      await flushSteps();
      // Adaptive concurrency — halve the effective batch width per pressure signal (an open circuit on one of
      // this batch's runtimes / a scheduler queue spike; both open or single-target-open = trickle at 1) and
      // restore automatically when the signal clears. Never cancels in-flight work; runSuite's worker count is
      // the ceiling. docs/architecture/batch-resilience.md
      const queuePressure = this.deps.queuePressure ?? 64;
      const gate = new AdaptiveConcurrencyGate({
        base: concurrency,
        factor: () => {
          let factor = 1;
          if (targets.length > 0) {
            const open = targets.filter((t) => this.breaker.isOpen(`${tenant}:${t}`)).length;
            if (open >= targets.length) return 0; // nowhere healthy → floor of 1 (trickle probe)
            if (open > 0) factor *= 0.5;
          }
          if ((this.deps.queueDepth?.() ?? 0) > queuePressure) factor *= 0.5;
          return factor;
        },
        onChange: (effective, previous) => {
          this.deps.onOrchestrationEvent?.({ kind: "concurrency_adapted", effective, previous, base: concurrency });
          pushStep(
            "dispatch",
            "info",
            effective < previous
              ? `concurrency shrunk ${previous} → ${effective} (runtime circuit / queue pressure)`
              : `concurrency restored ${previous} → ${effective}`,
          );
          void flushSteps();
        },
      });
      const gatedDispatch: Dispatch = (job) => gate.run(() => dispatch(job));
      // onResult: as each case finishes (completion order), record PASS/FAIL + reason as a step — the heart of "progress".
      scorecard = await runSuite(suite, harnessVersion, gatedDispatch, {
        concurrency,
        ...(opts.retries !== undefined ? { retries: opts.retries } : {}), // transient dispatch retry (throw-only)
        ...(trials > 1 ? { trials } : {}), // fan each case into N trials (pass@k / flakiness)
        // …minus the trials this batch already committed. A partially-seeded case stays in `casesToRun` (its
        // remaining trials still need dispatching); this is what stops the fan-out re-running the answered ones.
        ...(seededKeys.size > 0 ? { done: seededKeys } : {}),
        signal: controller.signal, // on supersede, don't fire remaining cases (already-fired cases complete naturally)
        onResult: (r) => {
          // A CASE IS "COMPLETED" WHEN ITS VERDICT IS FINAL, NOT WHEN ITS HARNESS RETURNS (arch-review 34 P1).
          //
          // The step and the fact used to be written here, carrying a verdict computed from the execution
          // scores alone — and then the judges ran, and `judge:<id>` is pass-deciding under the default
          // ladder. A watching agent (this fact's whole purpose: reacting MID-batch) could be told PASS about
          // a case the scorecard then records as FAIL. When the settle moved behind the judges, this stayed
          // where it was, so the code's own new invariant and its vocabulary disagreed.
          //
          // Both now happen where the child settles: after the judges, from the result they wrote into.
          // The lifecycle fact rides the commit transaction for EVERY outcome now — the failure exit goes
          // through the same finalizeCaseAttempt as a success (arch-review 41 P0-lifecycle), so the
          // best-effort special case that used to live here is gone with the asymmetry that needed it.
          const announce = (): void => {
            const v = caseVerdict(r, opts.verdictPolicy);
            const reason = caseReason(r);
            const verdict = v == null ? "no result" : v ? "PASS" : "FAIL";
            pushStep(
              "case",
              v === false ? "failed" : "ok",
              `${r.caseId} → ${verdict}${reason ? ` · ${reason}` : ""}`,
              r.caseId,
            );
            void flushSteps();
          };
          // A reclaimed batch fires no judges, so its child settles now with what it has — the alternative is
          // a row left running forever because the thing that was going to settle it was cancelled.
          if (controller.signal.aborted) {
            childSettles.push(
              this.commit
                .settleJudgedChild(
                  id,
                  tenant,
                  { ...(opts.verdictPolicy ? { verdictPolicy: opts.verdictPolicy } : {}), owner },
                  pendingChildSettle,
                  finalizedByFailure,
                  r,
                )
                .then((outcome) => {
                  if (outcome === "committed") announce();
                  return outcome;
                }),
            );
          }
          // After supersede, skip firing judges too (don't spend more LLM cost on a reclaimed batch).
          if (!controller.signal.aborted) {
            const judged = judgeStream.push(r);
            // …and the child settles HERE, once its judges have landed — terminal means finalized (P0 above).
            // `then(x, x)`: a judge that failed still produced its `unmeasured` row, and a child left running
            // by a rejected stream would be a zombie nothing settles.
            // …and the announcement, the export and the done-count are all DOWNSTREAM of that commit
            // (arch-review 35 P1). A settle refused because this driver lost the batch used to be followed
            // by "case completed" on the live bus and an export to the tenant's platform anyway — a case
            // announced and shipped by the one process whose result the ledger just declined.
            const settleJudged = (): Promise<"committed" | "lost" | "unwritten"> =>
              this.commit
                .settleJudgedChild(
                  id,
                  tenant,
                  { ...(opts.verdictPolicy ? { verdictPolicy: opts.verdictPolicy } : {}), owner },
                  pendingChildSettle,
                  finalizedByFailure,
                  r,
                )
                .then((outcome) => {
                  if (outcome !== "committed") return outcome;
                  announce();
                  // Case-completion chaining: export only after the case is BOTH judged and committed — and
                  // skip new fires after abort (already-fired exports complete naturally; the supersede path
                  // joins them and records a partial outcome).
                  if (exportStream && !controller.signal.aborted) exportStream.push(r);
                  return outcome;
                });
            childSettles.push(judged.then(settleJudged, settleJudged));
          }
        },
      });
      // Merge carried-over results back in (dataset case order) — seeds were already judged/exported on their
      // original run, so they bypass the judge/export streams (which only ever saw the re-run cases).
      if (seed.length > 0) {
        const order = new Map(dataset.cases.map((c, i) => [c.id, i] as const));
        scorecard = {
          ...scorecard,
          results: [...seed, ...scorecard.results].sort(
            (a, b) => (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0),
          ),
        };
      }
      pushStep("dispatch", "ok", `Dispatch complete — ${scorecard.results.length} case(s)`);
      await flushSteps();
      // Superseded — a newer fire reclaimed this batch. Skip the remaining pipeline (judge/offload/notify) and
      // terminate as superseded with only partial results attached (not succeeded, so baseline/leaderboard stay clean).
      if (controller.signal.aborted) {
        // Join already-fired judge tasks before persisting (prevents a race between in-progress scores mutation and write-back).
        // A judge error on a reclaimed batch is noise — swallow it.
        await judgeStream.settle().catch(() => {});
        await Promise.all(childSettles).catch(() => {}); // …and the children those judges were gating
        // Exports already sent via streaming are joined and recorded as a partial outcome (for tracking — superseded ≠ succeeded,
        // so baseline/leaderboard stay clean). If no cases went out, skip recording (an empty outcome is noise).
        const exportedPartial = exportStream ? await exportStream.settle().catch(() => undefined) : undefined;
        pushStep(
          "supersede",
          "info",
          "Replaced by a newer fire of the same PR — remaining cases not fired, only partial results kept",
        );
        const hasChildren = caseToChild.size > 0 || seedRunIds.length > 0;
        // …and the partial summary counts what the LEDGER holds, exactly as the success path's does — a
        // reclaimed batch's partials are the numbers a reader compares against the fire that replaced it.
        // Reconciled BEFORE the write-back, for the same reason the success path is ordered that way: the
        // committed children are compared against their own receipts, never against later bytes.
        const counted = await this.vouchedForSettle(id, tenant, scorecard, (m) => pushStep("persist", "info", m));
        if (hasChildren)
          await this.shared.writeBackResults(id, caseToChild, scorecard.results, { scorecardId: id, epoch });
        // The record was already marked superseded by supersedeInFlight — settle it with the partial outcome
        // (a legal re-write of a superseded record; the domain rejects it over succeeded/failed).
        const reclaimed = await this.deps.store.get(id);
        if (reclaimed && ScorecardBatch.from(reclaimed).canSettleAborted())
          await settleScorecard(
            this.deps.store,
            id,
            ScorecardBatch.from(reclaimed).settleAborted(
              {
                ...(counted.results.length > 0 ? { summary: summarizeScorecard(counted) } : {}),
                ...(exportedPartial?.cases?.length ? { export: exportedPartial } : {}),
                steps: [...steps],
                ...(hasChildren && seedChildBacked
                  ? { runIds: [...seedRunIds, ...caseToChild.values()] }
                  : // The embed is the summary's own basis, never a wider set: a reader who re-derives the
                    // numbers from the results this record carries must land on the numbers it published.
                    {
                      scorecard: counted,
                      ...(hasChildren ? { runIds: [...seedRunIds, ...caseToChild.values()] } : {}),
                    }),
              },
              this.now(),
            ).patch,
            undefined,
            // Same rule as the other aborted settles: partials attach to a batch that was reclaimed, never
            // to one that settled succeeded/failed.
            { over: "aborted", ...epochOpt },
          );
        this.inFlight.delete(id);
        return; // completion notification for a replaced batch is noise — skip
      }
      // runtime = the placement of the producing run → co-locate the judge on the same runtime (judge next to the artifacts). The ingest path has no producing run.
      // Since it's streaming, most overlap with dispatch and are already done — this is just joining the remaining tasks.
      // Task errors rethrow here → attributed to error.phase="judges" as before.
      phase = "judges";
      if (judges.length > 0) {
        pushStep("judges", "started", `${judges.length} judge kind(s) — joining remaining streaming tasks`);
        await flushSteps();
      }
      await judgeStream.settle(); // trace → judge scores (control plane, streamed the moment each case completes)
      // …and the child rows each of those judge tasks was gating. A child settles only once its case is fully
      // judged, so "the judges are done" and "the children are terminal" are the same moment by construction.
      //
      // AND A CASE THAT NEVER REACHED THE LEDGER REFUSES THE BATCH (arch-review 37 P0). The aggregate below
      // is built from THIS PROCESS'S results; the ledger is what a reader sees a year later. A parent that
      // succeeded while one of its cases was never written would publish a summary counting a result nobody
      // can find, and the disagreement is permanent — the batch is terminal, so nothing re-drives it. So an
      // unwritten case is an error, which fails this batch into a state recovery can pick up again.
      //
      // A `lost` case is not a failure: it means a takeover or a cancel took it, and whoever owns the batch
      // now owns the case too.
      const settlements = await Promise.all(childSettles);
      // A LOST CASE ENDS THIS DRIVER — actually ends it (arch-review 38 P1, review 39 P1). `lost` means the
      // batch was taken over or cancelled while the case was in flight. Aborting the controller was not
      // enough and reading it as "ends this driver" was wrong: an AbortController stops FUTURE dispatches and
      // some stream pushes, while every line below runs by direct call — offload the artifacts, export to the
      // tenant's platform, write the analysis object, write back the children, attempt the settle. The final
      // CAS refuses the STATUS and nothing else; an export cannot be un-sent and an object cannot be
      // un-written. So the loss is THROWN, and the catch below returns without touching anything.
      if (settlements.includes("lost")) {
        controller.abort(); // stop the sibling lanes too — they are working under the same lost authority
        throw new AuthorityLostError(
          "CONFLICT",
          { scorecard: id },
          "another driver owns this batch — this one stops without publishing anything",
        );
      }
      const unwritten = settlements.filter((outcome) => outcome === "unwritten").length;
      if (unwritten > 0)
        throw new InternalError(
          "UPSTREAM_ERROR",
          { scorecard: id, unwritten },
          `${unwritten} case(s) could not be written to the ledger — the batch cannot be summarized from results a reader will not find`,
        );
      if (judges.length > 0) {
        // Judge starvation is downstream of trace: if every case died before producing an outcome, the judges never
        // ran on anything real — say so explicitly instead of the misleading "judges applied".
        const js = judgeStream.stats();
        const judgeMsg =
          js.gradeable === 0
            ? `judges skipped: 0 gradeable traces (${js.skipped}/${js.pushed} failed pre-trace)`
            : js.skipped > 0
              ? `judges applied to ${js.gradeable}/${js.pushed} trace(s) (${js.skipped} failed pre-trace)`
              : "judges applied";
        pushStep("judges", "ok", judgeMsg);
        await flushSteps();
      }
      phase = "offload";
      // ── THE EMBED PATH'S OFFLOAD, AND ONLY ITS (arch-review 44) ──────────────────────────────────────
      //
      // Every case that has a CHILD had its snapshot offloaded per attempt, under `attempts/<attemptId>`, by
      // `assembleCaseEvidence` inside the commit — which is where it belongs: keyed by the execution that
      // produced the bytes, so a losing attempt cannot overwrite a winner's screenshot. Running this batch-
      // level pass over the same results afterwards did nothing (`offloadSnapshot` finds an emptied
      // `screenshot` and an already-sliced `dom` and returns the snapshot unchanged) and, for the results the
      // reconciliation replaces with the committed child's copy a few lines below, the mutation was discarded
      // even when it did fire. What it was NOT is harmless in principle: it mutates in-memory results between
      // the receipt that vouched for their bytes and the digest comparison that checks them, which is a
      // cry-wolf divergence waiting for the day it stops being a no-op.
      //
      // A batch with NO run store has no child, hence no per-attempt assembly (see finalizeCaseAttempt's
      // early return) — its results are embedded on the parent record raw, and this is the only pass that
      // slims them. That is the one case still served, so that is the case it now runs for.
      if (!this.deps.runStore) await offloadResults(this.deps, id, scorecard.results);
      // Trace-sink export (when configured) — even if it fails, the scorecard succeeds (recorded via outcome.status only, no error.phase).
      // With streaming (exportStream), cases already went out right after judging — here it's just joining remaining tasks + summing the outcome.
      // If not wired, fall back to the current batched export. TraceSinkService already doesn't throw, but isolate here too just in case.
      // Streaming exports already went out per-case, downstream of each case's own commit; joined here.
      const streamExported = exportStream ? await exportStream.settle().catch(() => undefined) : undefined;
      phase = "persist";
      // The aggregate is the LEDGER's, not this process's memory (see resultsFromLedger) — and the parity
      // check then compares what was counted against what was committed.
      const accounted = await this.resultsFromLedger(id, tenant, scorecard.results);
      scorecard = { ...scorecard, results: accounted.results };
      // The BATCHED export fallback runs on the RECONCILED results (arch-review 43): it used to fire on the
      // pre-reconciliation in-memory snapshot, so the payload a customer's platform received and the payload
      // this record persisted could legitimately disagree wherever the ledger substituted a committed
      // child's copy. The Temporal finalize already exported post-reconciliation; the two paths now agree.
      //
      // …AND THE BATCHED ONE NO LONGER RUNS HERE (arch-review 52, Wave 4). It ran BEFORE the terminal CAS
      // below, so a driver that lost the settle to a cancel had already shipped the batch's cases to someone
      // else's platform — an effect no CAS result can recall. It is now owed by the publication plan and
      // performed by the drain after the settle commits. The STREAMING export keeps firing where it did, and
      // the note below `plannedExport` says why that is a different question.
      const exported = streamExported;
      if (exported) pushStep("export", exported.status === "failed" ? "failed" : "ok", exportStepMessage(exported));
      // Only the batched fallback is deferred: a streaming batch already exported case by case, each fire
      // fenced by that CASE's own commit.
      const plannedExport = this.deps.exportResults !== undefined && !exportStream;
      // …AND THE RECEIPT SET IS EXACTLY THE PLAN'S (arch-review 41 P1). resultsFromLedger holds every
      // COUNTED case to a receipt; this holds the receipt set to the PLAN — a planned (caseId, trial) pair
      // no receipt answers, or a receipt the plan never asked for, refuses the success settle (recovery
      // re-drives). On the trial axis too: the id-only shape of this check was the trial hole.
      const expectedSet = dataset.cases.flatMap((c) =>
        Array.from({ length: trials }, (_, t) => ({ caseId: c.id, trial: trials > 1 ? t : 0 })),
      );
      if (accounted.receipts) {
        const setDelta = ScorecardBatch.caseSetDelta(expectedSet, accounted.receipts);
        if (setDelta.missing.length > 0 || setDelta.extra.length > 0)
          throw new InternalError(
            "UPSTREAM_ERROR",
            { scorecard: id, missing: setDelta.missing.slice(0, 20), extra: setDelta.extra.slice(0, 20) },
            `the committed receipt set is not the plan's (${setDelta.missing.length} missing, ${setDelta.extra.length} unplanned) — a success may only settle over exactly the case set the submit planned`,
          );
      }
      // THE SETTLE'S FROZEN READ-SET (review 40): the receipts the rebuild READ are what the terminal write
      // conditions on (expectReceiptCount) and what the record keeps — never a re-read.
      const decision = accounted.receipts
        ? ScorecardBatch.decisionContext(accounted.receipts, epoch, expectedSet)
        : undefined;
      await this.shared.checkReceiptParity(id, scorecard.results);
      const summary = summarizeScorecard(scorecard);
      // The per-revision artifact needs its revision number BEFORE the append — a light ledger pre-read
      // (the settle below re-reads race-tight as before; initial settles are revision 1 in practice).
      const priorScoring = (await this.deps.store.get(id))?.scoring;
      const initialBundle = analysisBundle(
        { scorecardId: id, dataset: exportCtx.dataset, harness: exportCtx.harness },
        summary,
        scorecard.results,
        opts.verdictPolicy,
      );
      // STAGED, NOT PUBLISHED (arch-review 52, Wave 4) — the content-addressed pass key only. The mutable
      // current-analysis alias is promoted by the drain after the settle commits, so a driver that loses the
      // terminal CAS cannot leave a cancelled batch's analysis surface describing a successful run.
      const passId = initialPassId(initialBundle);
      const analysis = await stageAnalysis(this.deps, id, initialBundle, passId);
      const publication = planPublication({
        scorecardId: id,
        bundle: initialBundle,
        staged: analysis,
        passId,
        exports: plannedExport,
        results: scorecard.results,
        ...(exportCtx.sinkOverride !== undefined ? { sink: exportCtx.sinkOverride } : {}),
        ...(exportCtx.judgeModels !== undefined ? { judgeModels: exportCtx.judgeModels } : {}),
        now: this.now(),
      });
      // leaderboard model axis: trace observation preferred + spec declaration (command harness only) fallback.
      const declared = modelBindingLabel(harnessSpec?.kind === "command" ? harnessSpec.model : undefined);
      const models = scorecardModels(scorecard, declared);
      // leaderboard judge axis: the judge model(s) that scored this run — inline config + registered model-judge spec.
      const judgeModels = await this.scoring.collectJudgeModels(tenant, judges, judge);
      pushStep("persist", "ok", "aggregated and persisted");
      // If there are child runs: write back the judge/offload-finalized results to the children, then store only runIds instead of the heavy embed
      //  → get hydrates from the children (storage dedup, response shape unchanged). Without children (no runStore), embed as before.
      const hasChildren = caseToChild.size > 0 || seedRunIds.length > 0;
      if (hasChildren)
        await this.shared.writeBackResults(id, caseToChild, scorecard.results, { scorecardId: id, epoch });
      const extras: ScorecardOutcomeExtras = {
        summary,
        // The stamped-policy verdict aggregate (arch-review 7 §4) — same derivation as the Temporal finalize.
        verdictSummary: verdictSummaryOf(scorecard.results, opts.verdictPolicy),
        ...(worldCohortOf(scorecard.results) ? { world: worldCohortOf(scorecard.results) } : {}),
        models,
        ...(judgeModels.length > 0 ? { judgeModels } : {}),
        ...(exported ? { export: exported } : {}),
        // The FROZEN artifact's ref, not the alias's — the alias does not exist until the drain promotes it
        // (arch-review 52, Wave 4), and the immutable object is the honest answer either way.
        ...(analysis.revisionRef ? { analysisRef: analysis.revisionRef } : {}),
        steps: [...steps],
        ...(hasChildren && seedChildBacked
          ? { runIds: [...seedRunIds, ...caseToChild.values()] }
          : { scorecard, ...(hasChildren ? { runIds: [...seedRunIds, ...caseToChild.values()] } : {}) }),
      };
      const settled = await this.deps.store.get(id);
      if (settled) {
        const batch = ScorecardBatch.from(settled);
        if (controller.signal.aborted) {
          // If supersede arrived mid-pipeline (judge/offload), don't revive to succeeded — all results attach, but
          // the newer fire is the answer for this PR, so terminate as superseded (leaderboard/baseline see only the new one).
          // The domain's own rule for this transition, at the storage boundary: it attaches an aborted
          // batch's partials and must never land on one that settled succeeded/failed — and the QUESTION is
          // asked (canSettleAborted) rather than the throw absorbed: a reclaimed driver whose predecessor's
          // success already settled has nothing to attach, and this branch is past the loop's last catch, so
          // the domain's refusal surfaced as an unhandled rejection (arch-review 42, pre-existing).
          if (batch.canSettleAborted())
            await settleScorecard(this.deps.store, id, batch.settleAborted(extras, this.now()).patch, undefined, {
              over: "aborted",
              ...epochOpt,
            });
        } else if (!batch.isTerminal()) {
          // E0 outbox: the completion fact rides the terminal transition and persists atomically with the settle.
          // Scoring identity — the INITIAL revision (same shape as the Temporal finalize; aborted settles
          // deliberately carry none: a cancelled batch never gates, so it has no judgment to identify).
          const scoring = appendScoringRevision(settled.scoring, {
            kind: "initial",
            judges: ExecutionPlan.of(settled).sealedJudges ?? judges,
            ...(ExecutionPlan.of(settled).sealedJudgeRun ? { judgeRun: ExecutionPlan.of(settled).sealedJudgeRun } : {}),
            results: scorecard.results,
            // The revision entry points at its own FROZEN artifact — never the mutable current key (I7).
            ...(analysis.revisionRef ? { analysisRef: analysis.revisionRef } : {}),
            // …and its durable KEY: the ref expires, and artifacts are keyed by the writing PASS now, so the
            // revision number no longer names the object a historical read has to fetch.
            ...(analysis.revisionKey ? { analysisKey: analysis.revisionKey } : {}),
            // WHAT THE JUDGES READ (arch-review 46) — the receipts the rebuild READ, the same frozen set the
            // terminal write conditions on. A run with no ledger says so rather than staying silent, because
            // silence here is the shape a later gate would have read as agreement.
            inputObservation: inputObservationOf(
              scorecard.results,
              accounted.receipts
                ? { kind: "read", receipts: accounted.receipts }
                : {
                    kind: "unavailable",
                    reason:
                      "this batch has no case-commit receipt ledger — its cases were counted from the in-memory plane, so nothing vouches for the executions these judges read",
                  },
            ),
            createdAt: this.now(),
            ...(settled.createdBy !== undefined ? { createdBy: settled.createdBy } : {}),
          });
          // …and the outward effects this settlement owes, persisted by the very write that decides it won
          // (arch-review 52, Wave 4). Only the SUCCESS settle carries a plan: an aborted batch's partials
          // publish nothing outward — it is not the batch's answer, so it does not own the current-analysis
          // alias and has no cases to ship as a completed evaluation.
          const settlement = batch.succeed(
            { ...extras, ...(decision ? { decision } : {}), scoring, ...(publication ? { publication } : {}) },
            this.now(),
          );
          const stamped = stampFacts(tenant, settlement.facts, { newId: this.newId, now: this.now });
          // Under the aggregate's terminal fence AND this driver's own epoch (mig 0166): a replica that was
          // declared dead and came back must not settle a batch another replica now owns. The comment below
          // already described "first terminal write wins" for the supersede race; the epoch is what makes it
          // true for the race nobody could see — a paused process whose loop never noticed it was replaced.
          const written = await settleScorecard(
            this.deps.store,
            id,
            settlement.patch,
            stamped.map((f) => f.record),
            {
              over: "open",
              ...epochOpt,
              ...(decision ? { expectReceiptCount: decision.receiptCount } : {}),
            },
          );
          // …and the metric hangs off the same commit as the facts (arch-review 31 P2) — a loser that still
          // counted its settlement would report a case outcome the ledger never recorded.
          if (written !== undefined) {
            if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
            // …AND ONLY NOW IS ANYTHING PUBLISHED (arch-review 52, Wave 4). Inline, holding the exact results
            // the settle counted; a crash before this line leaves the plan owed for the reconciler. Never a
            // reason for the batch to fail — an unpublished plan is a plan still owed, not a failed run.
            const drained = await drainPublication(
              this.deps,
              { ...written, ...(publication ? { publication } : {}) },
              scorecard.results,
              this.now,
            ).catch((): PublicationOutcome => ({ kind: "owed", reason: "publication drain threw" }));
            if (drained.kind === "owed")
              pushStep("export", "info", `Publication still owed — ${drained.reason} (the reconciler will retry)`);
            else if (drained.kind === "published" && drained.export)
              pushStep(
                "export",
                drained.export.status === "failed" ? "failed" : "ok",
                exportStepMessage(drained.export),
              );
            await flushSteps();
            // Operator time series (catalog M0): the closed outcome/reason vocabulary at the settle seam.
            this.deps.onOrchestrationEvent?.(
              batchSettledEvent(
                tenant,
                settled.createdAt,
                scorecard,
                settled.requested,
                Date.parse(this.now()),
                opts.verdictPolicy,
              ),
            );
          }
        }
        // else: a raced supersede settled the record before the abort signal reached this loop — first
        // terminal write wins, the late success is a no-op skip.
      }
    } catch (err) {
      // …and here is where "stop" means stop. A driver that lost its authority publishes NOTHING: no
      // write-back, no partial settle, no failure record. The batch is someone else's, including its ending —
      // recording a failure on it would be this process's last act of writing to a record it no longer owns.
      if (err instanceof AuthorityLostError) return;
      const base =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
      pushStep(phase, "failed", base.message);
      // Preserve partial results — on a post-dispatch (judge/offload) failure, persist the case results already gathered for visibility.
      // With child runs, mirror the success path: runIds references (partial) instead of embed + write back results to the children.
      const hasChildren = caseToChild.size > 0 || seedRunIds.length > 0;
      // THE FAILED BATCH'S NUMBERS ARE THE LEDGER'S TOO (arch-review 44). A failure is the path most likely to
      // hold results that never committed — that is often the very reason it failed — so counting this
      // process's memory here published the least trustworthy summary in the system as an ordinary one.
      // Lenient: the cases it cannot vouch for are dropped and named on the timeline, never a second throw
      // inside the handler that exists to record the first one.
      //
      // BEFORE the write-back, which is the success path's order and for its reason: the reconciliation
      // compares each committed child's bytes against its receipt, and a write-back that lands first would
      // have it comparing against bytes written after the receipt was stamped.
      const counted = scorecard
        ? await this.vouchedForSettle(id, tenant, scorecard, (m) => pushStep("persist", "info", m))
        : undefined;
      // Partial evidence still reaches the children — every result this process holds, not only the counted
      // ones: a case that could not commit is exactly the one whose row a reader will come looking at.
      if (scorecard && hasChildren)
        await this.shared.writeBackResults(id, caseToChild, scorecard.results, { scorecardId: id, epoch });
      const declared = modelBindingLabel(harnessSpec?.kind === "command" ? harnessSpec.model : undefined);
      const extras: ScorecardOutcomeExtras = {
        steps: [...steps],
        ...(hasChildren ? { runIds: [...seedRunIds, ...caseToChild.values()] } : {}),
        ...(counted
          ? {
              summary: summarizeScorecard(counted),
              models: scorecardModels(counted, declared),
              ...(hasChildren ? {} : { scorecard: counted }), // with children, skip embed (get hydrates)
            }
          : {}),
      };
      const settled = await this.deps.store.get(id);
      if (settled) {
        const batch = ScorecardBatch.from(settled);
        if (controller.signal.aborted) {
          // A failure after supersede isn't reported as a failure (a reclaimed batch's leftover errors are noise) — keep superseded.
          // Same guarded question as the success-path abort settle: a batch that already settled
          // succeeded/failed elsewhere takes no leftovers (first terminal write wins, arch-review 42).
          if (batch.canSettleAborted())
            await settleScorecard(
              this.deps.store,
              id,
              batch.settleAborted({ ...extras, error: { ...base, phase } }, this.now()).patch,
              undefined,
              { over: "aborted", ...epochOpt },
            );
        } else if (!batch.isTerminal()) {
          // E0 outbox: the failure fact rides the terminal transition and persists atomically with the settle.
          const settlement = batch.fail({ ...base, phase }, extras, this.now());
          const stamped = stampFacts(tenant, settlement.facts, { newId: this.newId, now: this.now });
          // "A late failure never overwrites it (first terminal write wins)" — said by the comment below,
          // enforced here (arch-review 30 P0). The `isTerminal()` above answers for this process; the cancel
          // it races is in another one.
          const failed = await settleScorecard(
            this.deps.store,
            id,
            settlement.patch,
            stamped.map((f) => f.record),
            {
              over: "open",
              ...epochOpt,
            },
          );
          if (failed !== undefined && stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
        }
        // else: a raced supersede already settled this record — a late failure never overwrites it (first
        // terminal write wins).
      }
    }
    this.inFlight.delete(id);
    // Completion notification (Mattermost etc.) — using the latest record. A failure is independent of the scorecard result (swallow). Replaced batches skip the notification.
    if (this.deps.onComplete && !controller.signal.aborted) {
      const rec = await this.deps.store.get(id);
      if (rec) await this.deps.onComplete(tenant, rec).catch(() => {});
    }
  }

  // Prove this loop still owns the batch. Returns false — and aborts the fan-out cooperatively — when the
  // epoch it began under is no longer the record's, which is what a takeover leaves behind for a driver that
  // never noticed it was replaced.
  //
  // A record nobody has claimed sits at epoch 0 and proves 0, which always holds — this fences takeovers,
  // not solitude, and it does so by asking every time rather than by exempting the common case.
  private async proveAuthority(
    id: string,
    fenced: { expectOwnerEpoch: number },
    controller: AbortController,
  ): Promise<boolean> {
    if (await this.shared.holdsBatch(id, fenced.expectOwnerEpoch)) return true;
    controller.abort(); // stop the sibling lanes too — they are dispatching under the same lost authority
    return false;
  }

  // ── THE PARENT COUNTS WHAT THE LEDGER COMMITTED (review 39 Phase 3 · review 40 P0) ───────────────────
  //
  // The in-process driver summarized the results it held IN MEMORY — the objects `runSuite` handed back. The
  // ledger is what a reader sees a year later, and the two can differ in the one way that matters: a case
  // whose canonical outcome is another attempt's. Nothing in memory knows that; the receipt does.
  //
  // Every counted outcome must trace to a receipt, on the (case, trial) axis the receipt's own key carries —
  // failures included, since the failure exit commits one too. And there is NO fallback to memory any more:
  // "receipt read failed", "fewer receipts than results" and "trialled batch" all used to quietly hand the
  // aggregate back to this process's memory, which is the Release defect in a different coat — a configured
  // authority that is unreadable is not an authority that is absent. A batch that cannot be accounted for on
  // the ledger REFUSES to summarize (the throw fails it into a state recovery re-drives), and a digest that
  // matches is what lets the in-memory object stand in for a child row that carries no result copy.
  private async resultsFromLedger(
    id: string,
    tenant: string,
    inMemory: CaseResult[],
    // No carried-result exception any more (arch-review 41 P0-lifecycle): a result carried from another
    // batch is materialized as THIS batch's seeded child + inherited receipt at retry time, so every counted
    // outcome — executed, failed, inherited — is held to the same receipt gate. The exception was the one
    // hole in it: a counted case with no receipt, no child and no digest, invisible to every reader.
    //
    // ── `lenient`: COUNT ONLY THE VOUCHED, BUT DO NOT REFUSE (arch-review 44) ────────────────────────
    //
    // The refusal above is the SUCCESS gate's: a batch that claims every case passed may not be summarized
    // over results the ledger cannot vouch for, and failing it leaves the batch open for recovery. A batch
    // that is already ending badly — failed, or reclaimed mid-flight — has nowhere better to be left: an
    // unaccounted case there is the ordinary shape (the very failure being recorded is often why a case never
    // committed), and throwing would only replace a failure record with an unhandled rejection and a batch
    // stuck open. So the same accounting runs and the unaccounted cases are DROPPED rather than counted:
    // the numbers ops-report, flake and pulse read stay receipt-vouched on every path, and `dropped` says
    // what was left out instead of the summary quietly disagreeing with the ledger.
    opts?: { lenient: true },
  ): Promise<{ results: CaseResult[]; receipts?: CaseCommitReceipt[]; dropped?: string[] }> {
    const runStore = this.deps.runStore;
    const receipts = this.deps.caseReceipts;
    if (!runStore || !receipts || inMemory.length === 0) return { results: inMemory };
    // Throws propagate: an unreadable ledger refuses the batch instead of summarizing from memory.
    const committed = await receipts.list(id);
    const children = await runStore.list(tenant, { scorecardId: id });
    const byKey = new Map(committed.map((r) => [childKey(r.caseId, r.trial), r] as const));
    const byId = new Map(children.map((c) => [c.id, c] as const));
    const rebuilt: CaseResult[] = [];
    const unaccounted: string[] = [];
    for (const r of inMemory) {
      const key = childKey(r.caseId, r.trial);
      const receipt = byKey.get(key);
      if (!receipt) {
        unaccounted.push(`${key} (no receipt)`);
        continue;
      }
      const child = byId.get(receipt.childRunId);
      // FULL-BYTES, deliberately (arch-review 46 revisiting 41): every caller of this rebuild is a SETTLE,
      // and a settle structurally predates any re-score — so the commit-time resultDigest is still the whole
      // truth, and an observation-only comparison would count a row whose score plane was tampered outside
      // any revision. The observation digest serves post-revision readers and the judgment input pin.
      const vouches = (candidate: CaseResult): boolean => caseResultDigest(candidate) === receipt.resultDigest;
      if (child?.result) {
        // The committed child's own copy is the answer — and its bytes must be the receipt's. A child row
        // that disagrees with its own receipt is a permanent divergence a reader will hydrate a year from
        // now; counting ANYTHING for that case (the row, or this process's memory) would publish a summary
        // built over bytes the ledger does not vouch for.
        if (vouches(child.result)) rebuilt.push(child.result);
        else unaccounted.push(`${key} (child digest mismatch)`);
        continue;
      }
      // A child with NO result copy (a legacy failure row) may be stood in for by the in-memory object ONLY
      // when the receipt vouches for its bytes — the digest is what turns "this process remembers" into
      // "the ledger agrees".
      if (vouches(r)) {
        rebuilt.push(r);
        continue;
      }
      unaccounted.push(`${key} (digest mismatch)`);
    }
    if (unaccounted.length > 0) {
      if (!opts?.lenient)
        throw new InternalError(
          "UPSTREAM_ERROR",
          { scorecard: id, unaccounted: unaccounted.slice(0, 20), count: unaccounted.length },
          `${unaccounted.length} counted case(s) cannot be traced to a committed receipt — the batch cannot be summarized from results the ledger does not vouch for`,
        );
      return { results: rebuilt, receipts: committed, dropped: unaccounted };
    }
    // The receipts ride back with the rebuild: they are the settle's READ-SET, and the decision context
    // freezes exactly this list (never a re-read, which could see a ledger the summary was not built over).
    return { results: rebuilt, receipts: committed };
  }

  // ── A BADLY-ENDING BATCH IS COUNTED THE SAME WAY A GOOD ONE IS (arch-review 44) ──────────────────────
  //
  // The failure and supersede settles persist a `summary`, and nothing downstream knows it was built
  // differently: ops-report, the flake lens and the workspace pulse read the same field on every record. They
  // were reading this process's MEMORY on those paths — every result the loop happened to hold, receipted or
  // not — while the success path had already been moved onto the ledger. That is not a small difference for
  // exactly the batches it applies to: a batch fails BECAUSE cases went unwritten, so the memory-derived
  // summary over-counts precisely where the discrepancy is largest.
  //
  // Lenient by construction (see resultsFromLedger): a failed batch may legitimately have unaccounted cases —
  // it is failed, that is what the record says. What it may not have is a summary counting them.
  private async vouchedForSettle(
    id: string,
    tenant: string,
    scorecard: Scorecard,
    note: (message: string) => void,
  ): Promise<Scorecard> {
    try {
      const accounted = await this.resultsFromLedger(id, tenant, scorecard.results, { lenient: true });
      const dropped = accounted.dropped ?? [];
      if (dropped.length > 0)
        note(
          `summary counts ${accounted.results.length} receipt-vouched case(s); ${dropped.length} uncommitted case(s) left out (${dropped.slice(0, 3).join(", ")})`,
        );
      return { ...scorecard, results: accounted.results };
    } catch (err) {
      // A ledger that cannot be READ is the one thing this cannot resolve honestly, and refusing is not
      // available here: the batch is ending either way, and a settle that throws leaves it open with nobody
      // coming back for it. So it falls back to memory and SAYS SO on the timeline — a stated approximation,
      // never a silent one.
      note(
        `summary could not be reconciled against the ledger (${err instanceof Error ? err.message : String(err)}) — counted from this process's results`,
      );
      return scorecard;
    }
  }
}
