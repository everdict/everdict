import {
  BadRequestError,
  CURRENT_EVIDENCE_VERSION,
  type CaseJob,
  type CaseKey,
  type CaseResult,
  type Dataset,
  type EvalCase,
  type HarnessSpec,
  InternalError,
  type JudgeRunConfig,
  NotFoundError,
  type RunRecord,
  type RuntimeWorkRef,
  type Scorecard,
  type ScorecardStep,
  type VerdictPolicy,
  caseKeyOf,
  encodeCaseKey,
} from "@everdict/contracts";
import type { JudgmentClaim } from "@everdict/contracts";
import {
  type CircuitBreaker,
  type HarnessSecretMaps,
  ScorecardBatch,
  billingCharges,
  caseResultDigest,
  caseVerdict,
  classifyFailure,
  modelBindingLabel,
  newScorecardChildRun,
  runEvidenceIdentity,
  scorecardModels,
  summarizeScorecard,
} from "@everdict/domain";
import {
  appendScoringRevision,
  applyGradingPlan,
  caseReason,
  childKey,
  initialScoringPassId,
  inputObservationOf,
  judgeClaimOfAttempt,
  judgmentReceiptsFromPlane,
  selectSubsetCases,
  verdictSummaryOf,
  worldCohortOf,
} from "@everdict/domain";
import { jobAttemptId, openPhysicalAttempt } from "../execution/open-physical-attempt.js";

// The correlation id a (case, trial) is DISPATCHED with — the same spelling the in-process driver's
// `executionIdOf` produces, so the frames, logs, live trajectory and replay of a case land under one id
// whichever driver ran it. It used to be `evd-<batch>-<case>` here with a comment saying the Temporal path
// has no trial fan-out; it does now, and two trials sharing a correlation id would interleave into one replay.
function executionIdFor(batchId: string, key: CaseKey): string {
  return `evd-${batchId}-${key.caseId}${key.trial !== undefined ? `-t${key.trial}` : ""}`;
}
import type { ScoringService, SealedJudgeClosure } from "../execution/scoring-service.js";
import { weightedTargets } from "../ops/shard-weights.js";
import { SpeculationController } from "../ops/speculation.js";
import { stampFacts } from "../platform-event/outbox.js";
import { settleScorecard } from "../ports/settle.js";
import { sealExecutionPlanes } from "../ports/trajectory-store.js";
import type { BatchDriverShared } from "./batch-driver-shared.js";
import type { CaseOutcomeCommitter } from "./case-outcome-committer.js";
import { ExecutionPlan } from "./execution-plan.js";
import { type PublicationOutcome, drainPublicationOperation, planPublicationOperation } from "./publication.js";
import type { RecoveryPlanner } from "./recovery-planner.js";
import type { ResilientCaseRunner } from "./resilient-case-runner.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";
import { analysisBundle, batchSettledEvent, initialPassId, stageAnalysis } from "./scorecard-observability.js";
import { embedHarnessSpec } from "./scorecard-plan.js";

// ── THE WORKFLOW-OWNED DRIVER ────────────────────────────────────────────────────────────────────────
//
// The three verbs the workflow calls over the internal routes — plan, run one case, finalize — and the
// per-batch context all three share, in one object because they are one driver. ONE INSTANCE per service,
// which is what the context map below requires (it is the cache a re-attaching workflow finds after a
// control-plane restart); the state a driver must never share across batches lives inside those context
// entries, keyed by batch id, never as a field on this object (arch-review 34).
export class WorkflowBatchDriver {
  private readonly commit: CaseOutcomeCommitter;
  private readonly scoring: ScoringService;
  private readonly breaker: CircuitBreaker;
  private readonly cases: ResilientCaseRunner;
  private readonly recovery: RecoveryPlanner;
  private readonly newId: () => string;
  private readonly now: () => string;
  // M2 dedup — one run.placement_blocked fact per batch (the step timeline keeps every sighting).
  private readonly placementBlockedAnnounced = new Set<string>();

  constructor(
    private readonly deps: ScorecardBatchDeps,
    private readonly shared: BatchDriverShared,
  ) {
    this.commit = shared.commit;
    this.scoring = shared.scoring;
    this.breaker = shared.breaker;
    this.cases = shared.cases;
    this.recovery = shared.recovery;
    this.newId = shared.newId;
    this.now = shared.now;
  }

  // --- Batch-on-Temporal internals (called by the workflow via the internal routes; the CP owns execution/
  // scoring/streaming, the workflow owns driver-loop durability — docs/architecture/temporal-batch-orchestration.md).
  // Per-batch resolved context, built by planBatch and reused per case (601 registry hits otherwise). Rebuilt
  // lazily after a CP restart; stepChain serializes progress-timeline appends across concurrent case calls.
  private readonly batchContexts = new Map<
    string,
    {
      tenant: string;
      owner: string;
      dataset: Dataset;
      harnessId: string;
      harnessVersion: string;
      harnessSpec?: HarnessSpec;
      // The model DOCUMENTS the manifest pinned for that spec (arch-review 19 P0-4) — carried to the job so
      // the dispatcher, where a `{ref}` finally becomes a provider and a key, can verify what it resolved.
      modelPins?: CaseJob["modelPins"];
      judges: Array<{ id: string; version: string }>;
      sealedJudges?: SealedJudgeClosure[]; // manifest.judges — the submit-time closure the per-case judging pins to (I6)
      judge?: JudgeRunConfig;
      retries: number;
      concurrency: number;
      secretMap?: HarnessSecretMaps;
      caseIndex: Map<string, EvalCase>; // placement target already assigned (stable round-robin by selected index)
      // How many PHYSICAL executions each case fans into (pass@k). The workflow drives one activity per
      // (case, trial) pair, so this is what turns the case index into the plan (arch-review 52, wave 1).
      trials: number;
      targets: string[]; // the shard list — spillover candidates (empty = no runtime selection)
      runtime?: string; // the batch's runtime selector — the judge co-locate placement (downstream report §6)
      speculation?: SpeculationController; // tail-straggler duplication (sharded batches only)
      memoryBoostMb?: Record<string, number>; // OOM escalation of a Temporal-owned retry (origin.memoryBoostMb)
      oomAutoBoost?: boolean; // in-batch OOM auto-boost (orchestration.oomAutoBoost)
      traceSink?: string; // per-batch sink override (orchestration.traceSink)
      // The batch's composed verdict policy (manifest.verdictPolicy) — absent = the built-in ladder. Live
      // per-case verdicts are decided by it so a watcher sees the same PASS/FAIL the settled record stamps.
      verdictPolicy?: VerdictPolicy;
      // The batch driver's fencing token, as this context read it when it was built (arch-review 33 P0). Every
      // CHILD write proves it, because a parent takeover raises the SCORECARD's epoch and leaves the child's
      // where it was — the child's own number cannot answer "am I still this batch's driver".
      driverEpoch: number;
      // Encoded (case, trial) keys, not case ids — the unit the ledger commits and the workflow drives.
      doneKeys: Set<string>;
      // Executions currently running in THIS process — a synchronous claim so a same-worker Temporal retry of
      // an in-flight execution skips instead of double-executing (gap 12). Empty on a fresh ctx (a dead worker
      // → cross-process retry re-executes, so recovery is unaffected). Keyed by (case, trial) for the same
      // reason the done set is: under trials, a case-id claim blocked a case's OTHER trials from starting.
      inFlightKeys: Set<string>;
      stepChain: Promise<void>;
    }
  >();

  // ONE verification, called by every path that re-resolves (arch-review 18 P0-2). It exists as a method
  // rather than as two call sites because the asymmetry it replaces was invisible: resume verified the harness
  // and not the dataset, the Temporal plan verified the dataset and not the harness, and each looked handled.
  //
  // NO PIN EXEMPTION (arch-review 19 P0-1). The first version skipped the harness comparison whenever
  // `origin.pinOverrides` was present, reasoning that a deliberate image swap is expected to differ from the
  // registry document. That reasoning describes a seal this batch does not have: submit seals the EFFECTIVE
  // spec — `resolveWithPins(base, pins)` — not the base, and every re-resolution re-applies the same pins to
  // whatever the base resolves to now. So the digests are directly comparable, the exemption bought nothing,
  // and it turned the pinned path into the one place a shadowed harness could execute uncaught:
  //
  //   submit  _shared/agent@1 = A, pins P  →  seal digest(resolveWithPins(A, P))
  //   later   tenant/agent@1  = B (same id@version, different command/env/topology)
  //   resume  resolveWithPins(B, P) = B'   →  verification SKIPPED because pins exist  →  B' executes
  //
  // A model closure cannot see that difference either, so nothing else was covering it.
  private async buildBatchContext(id: string): Promise<NonNullable<ReturnType<typeof this.batchContexts.get>>> {
    const rec = await this.deps.store.get(id);
    if (!rec) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "scorecard not found.");
    const orch = rec.orchestration;
    if (!orch) throw new BadRequestError("BAD_REQUEST", { scorecard: id }, "This batch has no orchestration inputs.");
    const plan = ExecutionPlan.of(rec); // the same one artifact the resume path consumes
    const resolved = await this.deps.datasets.get(rec.tenant, rec.dataset.id, rec.dataset.version);
    const { cases: selected } = selectSubsetCases(
      resolved,
      rec.subset ? { ids: rec.subset.ids, tags: rec.subset.tags, limit: rec.subset.limit } : undefined,
    );
    // …AND THE RE-READ DOCUMENTS MUST BE THE ONES THIS BATCH SEALED (arch-review 17 P0-1). A registry version
    // is immutable inside ONE namespace, and lookup is owner-first with a `_shared` fallback — so a workspace
    // registering its own `support@1` after submit shadows the shared document this manifest certified, and
    // every re-resolution (Temporal plan, resume, retry) silently gets different bytes under the same name.
    // Resume makes it worse than a reproducibility loss: finished cases are kept and only the unfinished ones
    // re-run, so one scorecard can hold cases evaluated under two different datasets, certified as one.
    //
    // Verified BEFORE the grading plan is applied — the plan is a batch document, and applying it first would
    // mask a change to the case's own default graders.
    plan.assertSelection(selected);
    // Re-apply the recorded grading plan — a workflow-driven case must score exactly like the original submit.
    const cases = applyGradingPlan(selected, orch.graders);
    // Sharding: same comma-list round-robin as the in-process loop, keyed by the SELECTED index so a re-plan after
    // a restart assigns every case the same target it had before.
    const targets = (rec.runtime ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    // History-weighted split (same as the in-process loop) — deterministic for a given history snapshot; a
    // mid-batch context rebuild may re-split remaining cases, which only moves NOT-YET-DISPATCHED work.
    const history =
      targets.length > 1
        ? await this.shared.shardHistory(rec.tenant, rec.harness.id, rec.harness.version, targets)
        : { ratios: new Map<string, number>() };
    const assigned = weightedTargets(cases.length, targets, history.ratios);
    const caseIndex = new Map<string, EvalCase>();
    cases.forEach((c, i) => {
      const target = targets.length > 0 ? assigned[i] : undefined;
      caseIndex.set(c.id, target ? { ...c, placement: { ...c.placement, target } } : c);
    });
    let harnessSpec: HarnessSpec | undefined;
    const pins = rec.origin?.pinOverrides;
    if (this.deps.harnesses) {
      const harnesses = this.deps.harnesses;
      // Registered → embed the resolved spec; unregistered/built-in (NotFound) → no spec embedded (as at submit). A
      // registered-but-invalid spec throws rather than re-dispatching specless (resume's caller absorbs the throw).
      // Re-resolution re-applies the manifest pin (I6): the `{ref}` bindings must execute the SUBMIT-time
      // resolution, not today's `latest` — and the DOCUMENT the pin is applied to is verified first, because
      // "the registry document is identical bytes (immutable version)" is true of the version and false of the
      // lookup, which resolves owner-first over `_shared` (arch-review 18 P0-2).
      const resolvedSpec = await embedHarnessSpec(
        () =>
          pins && Object.keys(pins).length > 0
            ? harnesses.resolveWithPins(rec.tenant, rec.harness.id, rec.harness.version, pins)
            : harnesses.get(rec.tenant, rec.harness.id, rec.harness.version),
        { id: rec.harness.id, version: rec.harness.version },
      );
      plan.assertHarness(resolvedSpec);
      harnessSpec = plan.pinSpec(resolvedSpec);
    }
    const owner = rec.createdBy ?? rec.tenant;
    const secretMap =
      harnessSpec && this.deps.scopedSecretsFor ? await this.deps.scopedSecretsFor(rec.tenant, owner) : undefined;
    const doneKeys = await this.recovery.doneCaseKeys(id, rec.tenant);
    const ctx = {
      tenant: rec.tenant,
      owner,
      dataset: { ...resolved, cases } as Dataset,
      harnessId: rec.harness.id,
      harnessVersion: rec.harness.version,
      ...(harnessSpec ? { harnessSpec } : {}),
      ...(plan.modelPins ? { modelPins: plan.modelPins } : {}),
      judges: orch.judges,
      ...(plan.sealedJudges ? { sealedJudges: plan.sealedJudges } : {}),
      ...(orch.judge ? { judge: orch.judge } : {}),
      retries: orch.retries,
      concurrency: orch.concurrency,
      ...(secretMap ? { secretMap } : {}),
      caseIndex,
      trials: Math.max(1, orch.trials ?? 1),
      targets,
      // The batch's runtime SELECTOR, kept for the judge co-locate placement — the durable driver used to
      // pass undefined here, so a co-located code/harness judge fell to the topology backend and skipped on
      // a registry miss instead of pinning to where the case actually ran (downstream report §6).
      ...(rec.runtime ? { runtime: rec.runtime } : {}),
      ...(rec.origin?.memoryBoostMb ? { memoryBoostMb: rec.origin.memoryBoostMb } : {}),
      ...(rec.orchestration?.oomAutoBoost ? { oomAutoBoost: true } : {}),
      ...(orch.traceSink ? { traceSink: orch.traceSink } : {}),
      // The batch's own composed policy, sealed in the manifest at submit — the live verdicts and the
      // settle-time analysis bundle are judged under it, never under whatever the ladder says today.
      ...(plan.verdictPolicy ? { verdictPolicy: plan.verdictPolicy } : {}),
      // Tail speculation — sharded batches only. The controller lives with the batch context (rebuilt with
      // empty duration history on a CP restart — it re-learns the median from the resumed cases).
      ...(targets.length > 1
        ? {
            speculation: new SpeculationController({
              targets,
              tenant: rec.tenant,
              breaker: this.breaker,
              totalCases: caseIndex.size,
              ...(() => {
                const reattempt = this.cases.reattemptOf({
                  tenant: rec.tenant,
                  scorecardId: id,
                  driverEpoch: rec.ownerEpoch ?? 0,
                  concurrent: true, // the duplicate races the primary — neither supersedes the other at open
                });
                return reattempt ? { reattempt } : {};
              })(),
              ...(history.seedMedianSec !== undefined ? { seedMedianMs: history.seedMedianSec * 1000 } : {}),
              onSpeculate: (cid: string, from: string, to: string) => {
                this.deps.onOrchestrationEvent?.({ kind: "speculation_fired", from, to });
                void this.appendBatchStep(id, {
                  phase: "case",
                  status: "info",
                  message: `${cid}: tail speculation ${from} ⇢ ${to} (straggler duplicate)`,
                  caseId: cid,
                });
              },
              onLoser: (outcome, cid: string) => this.shared.meterLostAttempt(rec.tenant, outcome, cid, id),
              onLoserFailure: (lostJob, cid: string) => this.shared.stampLostBranch(lostJob, cid),
              ...(this.deps.cancelQueued
                ? {
                    cancelQueued: (cid: string) =>
                      void this.deps.cancelQueued?.((j) => j.batchId === id && j.evalCase.id === cid),
                  }
                : {}),
            }),
          }
        : {}),
      doneKeys,
      // The parent's token as this driver reads it when it takes the batch up. The Temporal path rebuilds
      // this context after a restart, which is exactly when it must be re-read: the worker that rebuilds it
      // IS the current driver, and a worker holding an older context has already lost its activities.
      driverEpoch: rec.ownerEpoch ?? 0,
      inFlightKeys: new Set<string>(),
      stepChain: Promise.resolve(),
    };
    this.batchContexts.set(id, ctx);
    return ctx;
  }

  // Serialized progress-step append (read-modify-write on record.steps is racy across concurrent case calls).
  appendBatchStep(id: string, step: Omit<ScorecardStep, "ts">): Promise<void> {
    const ctx = this.batchContexts.get(id);
    const doAppend = async (): Promise<void> => {
      const rec = await this.deps.store.get(id);
      if (!rec) return;
      await this.deps.store.update(id, {
        steps: [...(rec.steps ?? []), { ts: this.now(), ...step }],
        updatedAt: this.now(),
      });
    };
    if (!ctx) return doAppend();
    ctx.stepChain = ctx.stepChain.then(doAppend, doAppend);
    return ctx.stepChain;
  }

  // planBatch — resolve the remaining work (idempotent: a re-attached workflow gets only unfinished cases).
  //
  // THE PLAN'S UNIT IS (case, trial) (arch-review 52, wave 1). It was case ids, so a batch with trials > 1
  // could not be driven here at all — N executions of one case collapsed to one plan entry — and submit had
  // to route every pass@k batch away from the durable driver onto the in-process loop, which is precisely the
  // work that most wants durability (k× the runtime, k× the exposure to a restart). `items` carries the pair;
  // `caseIds` stays beside it so a workflow execution started before this shipped keeps driving from its own
  // history without seeing an unknown field.
  async planBatch(id: string): Promise<{ caseIds: string[]; items: CaseKey[]; concurrency: number }> {
    const ctx = await this.buildBatchContext(id);
    const remaining = this.planItems(ctx).filter((key) => !ctx.doneKeys.has(encodeCaseKey(key)));
    // Read-guarded start: a re-attached workflow re-plans a running batch (legal), but a settled/superseded
    // record is never revived to running (first terminal write wins; runBatchCase skips per case anyway).
    const rec = await this.deps.store.get(id);
    if (rec) {
      const batch = ScorecardBatch.from(rec);
      if (!batch.isTerminal())
        await this.deps.store.update(id, batch.start(this.now()).patch, undefined, { expectNonTerminal: true });
    }
    await this.appendBatchStep(id, {
      phase: "dispatch",
      status: "started",
      message: `Running ${remaining.length} case(s) via Temporal workflow${ctx.doneKeys.size > 0 ? ` (${ctx.doneKeys.size} finished case(s) kept)` : ""}`,
    });
    // `caseIds` is the legacy projection for an in-flight workflow that predates `items` — it can only spell
    // one entry per case, so under trials it deduplicates. A pre-`items` workflow driving a trialled batch is
    // impossible (submit refused to start one), which is what makes the narrowing safe rather than lossy.
    return { caseIds: [...new Set(remaining.map((k) => k.caseId))], items: remaining, concurrency: ctx.concurrency };
  }

  // The batch's full plan as (case, trial) pairs, in dispatch order (all trials of a case adjacent, mirroring
  // the in-process fan-out). A single-trial batch yields keys with no trial axis, so its plan entries encode
  // and address exactly as they always did.
  private planItems(ctx: { caseIndex: Map<string, EvalCase>; trials: number }): CaseKey[] {
    return [...ctx.caseIndex.keys()].flatMap((cid) =>
      ctx.trials > 1 ? Array.from({ length: ctx.trials }, (_, t) => caseKeyOf(cid, t)) : [caseKeyOf(cid)],
    );
  }

  // runBatchCase — execute + settle exactly one case (idempotent). Mirrors the in-process track dispatch closure:
  // budget admit → child run → secret resolve → executeCase (CP-side transient retry by failure class) → settle →
  // per-case judges → progress step. Kept deliberately parallel to track() — the two drivers share every primitive
  // (executeCase, classifyFailure, applyJudges, billing), only the loop ownership differs.
  //
  // `trial` absent = a single-trial batch, byte-identical to every call this activity has ever received. When
  // it is present the whole execution — the claim, the child row, the correlation id, the job, the result's
  // own stamp and the done marker — carries it, because a trial is a separate physical execution with its own
  // receipt, not a repetition of the same one (arch-review 52, wave 1).
  async runBatchCase(id: string, caseId: string, trial?: number): Promise<{ settled: boolean; skipped?: boolean }> {
    const ctx = this.batchContexts.get(id) ?? (await this.buildBatchContext(id));
    const caseKey = caseKeyOf(caseId, trial);
    const workKey = encodeCaseKey(caseKey);
    // Aborted mid-flight (a newer fire superseded this batch, or the user cancelled it) — don't spend more
    // compute/LLM on it. The workflow is cancelled cooperatively; this guard covers activities already in the
    // queue, and it keys on TERMINAL (not just superseded): a user-cancelled batch's queued activities would
    // otherwise run whole cases — and mint fresh queued child runs — for a batch that is already dead.
    const current = await this.deps.store.get(id);
    if (current && ScorecardBatch.from(current).isTerminal()) return { settled: true, skipped: true };
    if (ctx.doneKeys.has(workKey)) return { settled: true, skipped: true };
    // Concurrent-dispatch guard (gap 12): a Temporal retry can re-invoke runBatchCase for the SAME caseId (same worker)
    // while the original is still in-flight — before doneIds is set — so both used to execute the harness (wasted
    // compute; the durable result was already at-most-once via doneIds/planBatch). Claim the caseId SYNCHRONOUSLY here
    // so the second invocation skips; release in `finally` so a failed/incomplete attempt is retryable. A cross-process
    // retry (a dead worker → ctx rebuilt) has an empty claim set, so genuine recovery is unaffected.
    if (ctx.inFlightKeys.has(workKey)) return { settled: true, skipped: true };
    ctx.inFlightKeys.add(workKey);
    try {
      const evalCase = ctx.caseIndex.get(caseId);
      if (!evalCase) throw new NotFoundError("NOT_FOUND", { scorecard: id, caseId }, "case not in this batch.");

      this.deps.budget?.admit(ctx.tenant);
      const runStore = this.deps.runStore;
      const caseEnvelope = current ? await this.shared.childEnvelope(current) : undefined; // §5.2 — the delegated pool this case draws from
      let child: RunRecord | undefined;
      if (runStore) {
        child = newScorecardChildRun({
          id: this.newId(),
          tenant: ctx.tenant,
          harness: { id: ctx.harnessId, version: ctx.harnessVersion },
          caseId,
          parentScorecardId: id,
          executionId: executionIdFor(id, caseKey),
          ...(evalCase.placement?.target ? { runtime: evalCase.placement.target } : {}),
          ...(current ? { origin: ScorecardBatch.childRunOrigin(current) } : {}),
          ...(caseEnvelope ? { envelope: caseEnvelope } : {}),
          now: this.now(),
        });
        // THE CHILD ROW IS THE DISPATCH INTENT (arch-review 33 P1). Committing it under the parent's fencing
        // token is what turns "prove, then hope" into one decision: a driver displaced between its authority
        // proof and this insert writes no row, and a case with no child is never dispatched. The refusal
        // arrives as ConflictError, the same shape the proof gives, so the loop aborts the way it already does.
        await runStore.create(child, undefined, { parentDriver: { scorecardId: id, epoch: ctx.driverEpoch } });
      }
      // THIS CASE'S ATTEMPT, ON THIS DRIVER TOO (review 39 P0-2/P0-3). The in-process loop opens one at
      // dispatch intent; this path opened none at all, so a Temporal-driven case had no attempt to fence and
      // its producers wrote under whatever number the receiving process held. An `open` that throws is a
      // fence we could not raise, not a fence that was unnecessary — the case still runs, knowing its replay
      // is not canonical (`unisolated`).
      const executionId = executionIdFor(id, caseKey);
      // …and the attempt LEDGER records it happened at all (arch-review 42): the recording row is where the
      // evidence goes, this is where the fact that a physical execution began goes — including when the
      // recording claim is refused and the case runs unisolated.
      // Nobody to tell about the number: it travels ON THE JOB (review 39, Phase 4), so the producer that
      // matters cannot be missed by a wiring nobody remembered to do.
      const opened = await openPhysicalAttempt(
        { attempts: this.deps.attempts, recordings: this.deps.recordingStore },
        {
          executionId,
          tenant: ctx.tenant,
          scorecardId: id,
          caseId,
          driverEpoch: ctx.driverEpoch,
          ...(child ? { childRunId: child.id } : {}),
        },
      );
      const generation = opened.generation;
      const unisolated = opened.unisolated;
      const attemptId = opened.attemptId;
      const baseJob: CaseJob = {
        evalCase,
        harness: { id: ctx.harnessId, version: ctx.harnessVersion },
        tenant: ctx.tenant,
        batchId: id, // scheduler-side reclaim key (supersede / speculation-loser queue cancel)
        runId: executionId, // trace correlation — one correlation id per (case, trial)
        ...(trial !== undefined ? { trial } : {}),
        ...(generation !== undefined ? { recordingGeneration: generation } : {}),
        // …and the LEDGER row this execution is, by name (arch-review 51). Present even when the recording
        // claim was refused, which is the case the generation cannot cover: it is how a self-hosted park
        // records which attempt it parked, and how an unisolated attempt stays addressable at all.
        ...(attemptId !== undefined ? { attemptId } : {}),
        priority: "batch", // fan-out work — yields the queue to interactive single runs
        ...(ctx.owner ? { submittedBy: ctx.owner } : {}),
        ...(ctx.harnessSpec ? { harnessSpec: ctx.harnessSpec } : {}),
        // The model DOCUMENTS this batch pinned, carried to the dispatcher (arch-review 19 P0-4). The spec's
        // bindings already carry the pinned VERSION; a version is not an identity under owner-first
        // resolution, so the digest has to travel with it or the last hop cannot tell which document it got.
        ...(ctx.modelPins ? { modelPins: ctx.modelPins } : {}),
        ...(ctx.judge ? { judge: ctx.judge } : {}),
      };
      let result: CaseResult | undefined;
      let ranOn: string | undefined; // the runtime that actually ran the case (spillover provenance)
      // The job of the CURRENT physical attempt — a control-plane retry re-dispatches under a fresh
      // recording generation (review 40 follow-up), and the WINNER's job is what the finalizer references.
      let currentJob: CaseJob = baseJob;
      let winnerJob: CaseJob | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          const childId = child?.id;
          const reattempt = this.cases.reattemptOf({
            tenant: ctx.tenant,
            scorecardId: id,
            driverEpoch: ctx.driverEpoch,
          });
          const outcome = await this.cases.run(currentJob, {
            owner: ctx.owner,
            targets: ctx.targets,
            tenant: ctx.tenant,
            secretMap: ctx.secretMap,
            boostMb: ctx.memoryBoostMb?.[caseId],
            oomAutoBoost: ctx.oomAutoBoost,
            speculation: ctx.speculation,
            ...(reattempt ? { reattempt } : {}),
            onWaiting: (reason) => {
              void this.appendBatchStep(id, { phase: "dispatch", status: "info", message: reason });
              // M2 live-anomaly fact — ONCE per batch (500 blocked cases must read as one signal, not a flood):
              // the same verdict the step timeline shows, announced so subscriptions/agents can react.
              if (!this.placementBlockedAnnounced.has(id)) {
                this.placementBlockedAnnounced.add(id);
                void this.deps.events
                  ?.emit({
                    workspace: ctx.tenant,
                    kind: "run.placement_blocked",
                    subject: { type: "scorecard", id },
                    payload: { reason },
                    message: `Scorecard ${id} has cases that cannot start — ${reason}`,
                  })
                  ?.catch?.(() => {});
              }
            },
            // WHERE THIS CASE'S COMPUTE WILL BE, recorded before it exists (arch-review 53, Wave A). The
            // durable lane is precisely the lane whose handle has to outlive the process, and it was the one
            // lane that never reported it: this driver forwarded onWaiting/onStarted/onStep and nothing else,
            // so every managed case a Temporal batch dispatched was addressable only by its case id after a
            // restart. Awaited by contract — a handle that cannot be recorded aborts the dispatch instead of
            // producing compute nobody can name.
            // ONE capability (arch-review 58 W2): the reservation and its re-presentation at the object's birth
            // travel together, so this lane cannot supply the half it happens to remember — which is exactly what
            // it did until now, having no activation at all.
            authority: {
              reserve: (work: RuntimeWorkRef) => this.commit.reserveWork(work),
              activate: (work: RuntimeWorkRef) => this.commit.activateWork(work),
            },
            // COMPUTE ACTUALLY STARTED — the child flips queued→running, and the attempt ledger records that
            // this execution reached the machine rather than only having been intended (arch-review 42).
            // Keyed to the STARTED job's own coordinates (arch-review 51 residue): a spill/OOM reattempt
            // dispatches a different attempt, and the dispatch-time capture named the abandoned one.
            onStarted: (startedJob) => {
              void this.commit.stampAttempt(jobAttemptId(startedJob, executionId) ?? attemptId, "executing");
              if (childId && runStore) void this.commit.markChildRunning(childId);
            },
            onStep: (message, cid) =>
              void this.appendBatchStep(id, { phase: "case", status: "info", message, caseId: cid }),
          });
          // Stamp the trial from the job — the harness runs one case and does not know which repetition it
          // is (the same stamp `runSuite` applies on the in-process path, which this driver has no runSuite
          // to inherit it from). Without it the receipt, the child row and the score plane would all record
          // trial 0 for every repetition of a case.
          result =
            trial !== undefined && outcome.result.trial === undefined ? { ...outcome.result, trial } : outcome.result;
          ranOn = outcome.target;
          winnerJob = outcome.job;
          break;
        } catch (err) {
          const failure = classifyFailure(err, "dispatch");
          if (attempt >= ctx.retries || !failure.retryable) {
            const message = err instanceof Error ? err.message : String(err);
            result = {
              caseId,
              ...(trial !== undefined ? { trial } : {}),
              harness: `${ctx.harnessId}@${ctx.harnessVersion}`,
              evidenceVersion: CURRENT_EVIDENCE_VERSION, // synthesized after retries ran out — nothing to vouch for
              trace: [{ t: 0, kind: "error", message }],
              snapshot: { kind: "prompt", output: "" },
              // UNMEASURED diagnostic — the failedCaseResult twin on the batch retry-exhausted path.
              scores: [
                {
                  graderId: "dispatch",
                  metric: "error",
                  status: "unmeasured",
                  reason: "missing_evidence",
                  retryable: failure.retryable,
                  detail: `[${failure.class}] ${message}`,
                },
              ],
              failure,
            };
            break;
          }
          await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
          // The retry is a NEW physical execution — it opens its own attempt rather than writing into the
          // one the failed dispatch may still have late producers for.
          currentJob =
            (await this.cases.reattemptOf({ tenant: ctx.tenant, scorecardId: id, driverEpoch: ctx.driverEpoch })?.(
              currentJob,
            )) ?? currentJob;
        }
      }
      // Which attempt the case's answer belongs to: the winner's (a spill/boost/duplicate opened its own);
      // a synthesized failure belongs to the LAST attempt dispatched. Absent = no attempt was isolatable.
      const winnerGeneration = (winnerJob ?? currentJob).recordingGeneration;
      const winnerUnisolated = this.deps.recordingStore !== undefined && winnerGeneration === undefined;
      // …and its LEDGER ROW, by name (arch-review 51). The job carries it, so an UNISOLATED winner — whose
      // generation is absent by definition — still has a row to terminalize, which is the case where the
      // derivation from the generation could only answer "unknown" and the attempt stood `created` for ever.
      // No fallback to the DISPATCH's attempt: a winner carrying neither half ran under an attempt whose open
      // failed outright, and naming its predecessor would stamp a row this execution never used.
      const winnerAttemptId = jobAttemptId(winnerJob ?? currentJob, executionId);
      // Bill the case, itemized per model: managed/ws-runner bill the whole cost; an own-pays personal self-hosted run
      // bills the workspace only for calls on a workspace-billed model. The same lines feed the meter + enforcement budget.
      let caseUsd = 0;
      for (const c of billingCharges(result, ctx.tenant)) {
        this.deps.budget?.settle(c.tenant, c.cost);
        this.deps.usage?.record(c.tenant, c.source, c.model, c.cost, c.evaluations);
        caseUsd += c.cost.usd;
      }
      // Envelope draw-down (§5.2 O7 meter): the full caused cost charges the delegating envelope.
      if (caseEnvelope && caseUsd > 0) void this.deps.envelopes?.settle(caseEnvelope.id, ctx.tenant, caseUsd);
      // DOES THIS LOOP STILL HOLD THE BATCH? Asked once more here, because everything below PUBLISHES — the
      // execution plane, the judges' own planes, the child's settle. A driver displaced while this case ran
      // would otherwise plant the permanent trajectory of an execution whose settle is refused a moment
      // later, and the successor's re-drive — the one whose result the child keeps — would then find its own
      // seal refused as a re-offer. The case really did execute; it is simply not this driver's to publish.
      if (!(await this.shared.holdsBatch(id, ctx.driverEpoch))) return { settled: false };
      // P5 dual-write: the case's trajectory seals in the OWNED store under its child run id (idempotent).
      //
      // WHY THIS ONE SEALS BEFORE ITS SETTLE, unlike the standalone run's (arch-review 32 P0). The judges
      // below score onto this result and their own executions seal as `judge:<id>` planes on the child's
      // trajectory — so the execution plane has to exist first, and the child's settle carries what the
      // judges produced. Reordering would make a judge plane the segment that CREATES the trajectory, and
      // the judge seal carries no identity, so the browse row would arrive unnamed.
      //
      // What makes the order safe is that nothing here runs without authority: the child row is committed
      // under the parent's token, the loop proves itself before each dispatch, and the check just above
      // proves it once more before any of this publishes. A driver that lost the batch reaches none of it.
      if (child && result.trace.length > 0)
        if (this.deps.trajectories)
          void sealExecutionPlanes(this.deps.trajectories, {
            runId: child.id,
            tenant: ctx.tenant,
            events: result.trace,
            // WHOSE evidence this is (review 39 P1) — the same identity the receipt records, so a reader can
            // ask whether the replay in front of them belongs to the execution that produced the verdict.
            // Only when the attempt is KNOWN (arch-review 46): `?? 0` fabricated `<executionId>#g0` — a
            // coordinate the attempt ledger never mints (first attempt owns 1) — and every unisolated case
            // collided on it. Unknown is stated as absent, exactly like the receipt does.
            // …read through the one place that knows both halves (jobAttemptId, arch-review 51), so an
            // unisolated attempt names its row here too instead of sealing anonymously.
            ...(winnerAttemptId !== undefined ? { attemptId: winnerAttemptId } : {}),
            // Names the row on the browse page: an eval is known by the case it evaluated.
            ...runEvidenceIdentity(child),
            // The producer's declared clock anchor (a topology case: drive start) — what lets an inline
            // trace with only relative `t` land on the placement plane's wall-clock axis.
            ...(result.traceT0 !== undefined ? { t0: result.traceT0 } : {}),
          }).catch(() => {});
      // Per-case judge scoring — the same "judge the moment the case lands" semantics as the in-process judge stream.
      // The child run id rides along so the judge's own execution seals as a judge:<id> plane on it (the case's
      // execution plane sealed just above, so the judge plane joins an already-named trajectory).
      // The per-invocation ordinal this lane can state, or nothing (arch-review 53, Wave D). An unisolated
      // attempt has a ledger row and NO recording generation, and inventing one here is exactly the
      // fabrication `identity-sentinel-guard` refuses — the receipt says "no ordinal" by carrying no claim,
      // which is also what `judgeEvidenceEmitter` names differently.
      // …DERIVED BY THE EMITTER'S OWN OWNER (arch-review 55, Wave 4): the finalize has to answer this same
      // question from the commit receipt, and while the derivation lived here it simply did not answer it.
      const judgeClaimOf = (attemptId: string | undefined): { claim: JudgmentClaim } | undefined => {
        const claim = judgeClaimOfAttempt(attemptId);
        return claim === undefined ? undefined : { claim };
      };
      if (ctx.judges.length > 0) {
        await this.scoring
          .applyJudges(
            ctx.tenant,
            ctx.dataset,
            [result],
            ctx.judges,
            // The runtime the case actually ran on (spillover-aware), else the batch's selector — the judge
            // co-locates with the artifacts it grades. `undefined` sat in this slot, so a co-located
            // code/harness judge fell to the topology backend and skipped on a registry miss.
            ranOn ?? ctx.runtime,
            ctx.owner,
            () => child?.id,
            ctx.sealedJudges,
            // …and its evidence plane seals only while this activity still holds the batch (arch-review 35
            // P0). The probe was added to the in-process loop and not to this one, so the very race the fix
            // is named after stayed open on the driver an operator running Temporal actually uses.
            () => this.shared.holdsBatch(id, ctx.driverEpoch),
            // EVERY JUDGING IS A PASS, AND THIS LANE'S INVOCATIONS ARE PLURAL (arch-review 53, Wave D). The
            // case activity carries `retry: { maximumAttempts: 10 }` and a one-minute heartbeat timeout, so
            // a worker death re-runs the case and judges it again — the first invocation may already have
            // sealed its evidence plane. The claim is what tells the two apart: its generation is the
            // PHYSICAL attempt's (a re-run opens a new ledger row, so the number moves with the re-run) and
            // its attempt is this driver's own retry index.
            {
              passId: initialScoringPassId(id),
              // The generation comes from the physical attempt this case actually ran as — a re-run of the
              // activity opens a new ledger row, so the number moves with the re-run. Absent (an unisolated
              // attempt that could not claim a recording fence) means this lane has no ordinal to state, and
              // the receipt says so by carrying no claim rather than by inventing one.
              ...(judgeClaimOf(winnerAttemptId) ?? {}),
            },
          )
          .catch(() => {});
      }
      // ── ONE FINALIZER, BOTH DRIVERS (review 39, Phase 2) ─────────────────────────────────────────────
      //
      // Judge coverage, the receipt claim, the evidence assembly and the child's one terminal write are no
      // longer this path's own code. They were, and every review since has found the same defect in whichever
      // copy was edited second — which is why the duplication, not the individual bugs, was the finding.
      const outcome = await this.commit.finalizeCaseAttempt({
        scorecardId: id,
        epoch: ctx.driverEpoch,
        result,
        judges: ctx.judges,
        ...(ctx.sealedJudges ? { sealedJudges: ctx.sealedJudges } : {}),
        tenant: ctx.tenant,
        announce: {
          ...(ctx.verdictPolicy ? { verdictPolicy: ctx.verdictPolicy } : {}),
          ...(ctx.owner !== undefined ? { owner: ctx.owner } : {}),
        },
        ...(child ? { childId: child.id } : {}),
        executionId,
        // Absent when the attempt never opened one — finalizeCaseAttempt's own guard (unknown ⇒ no
        // attemptId on the receipt, unisolated evidence) was DEAD CODE while this caller wrote 0.
        ...(winnerGeneration !== undefined ? { generation: winnerGeneration } : {}),
        // …and the ledger row BY NAME (arch-review 51): the terminal stamp used to be derivable only from the
        // generation, so an unisolated attempt — which has a row and no generation — was never terminalized.
        ...(winnerAttemptId !== undefined ? { attemptId: winnerAttemptId } : {}),
        ...(unisolated || winnerUnisolated ? { unisolated: true } : {}),
        ...(ranOn ? { ranOn } : {}),
      });
      // A CHILD COMMIT THAT DID NOT HAPPEN IS NOT A SETTLED CASE (review 39 P0-3). `lost` means another
      // attempt owns the case (or this driver was displaced); `unwritten` means the store refused it. Either
      // way this activity did not settle it, and saying otherwise let a case with no result on the ledger
      // pass the finalizer's missing-case check.
      if (outcome.kind !== "committed") return { settled: false };
      result = outcome.result; // what the child carries is what this activity counts
      ctx.doneKeys.add(workKey);
      const v = caseVerdict(result, ctx.verdictPolicy);
      const reason = caseReason(result);
      const verdict = v == null ? "no result" : v ? "PASS" : "FAIL";
      await this.appendBatchStep(id, {
        phase: "case",
        status: v === false ? "failed" : "ok",
        message: `${trial === undefined ? caseId : `${caseId} · trial ${trial}`} → ${verdict}${reason ? ` · ${reason}` : ""}`,
        caseId,
      });
      // The lifecycle FACT rode the commit transaction itself (finalizeCaseAttempt, E0) — persisted with the
      // child's terminal write and pushed to the live bus there, so nothing is emitted here.
      return { settled: true };
    } finally {
      ctx.inFlightKeys.delete(workKey); // release the claim so a failed/incomplete attempt (or the next one) is unblocked
    }
  }

  // finalizeBatch — aggregate the children into the final record (summary/models/judges/export) and notify.
  async finalizeBatch(id: string): Promise<void> {
    const ctx = this.batchContexts.get(id) ?? (await this.buildBatchContext(id));
    const rec = await this.deps.store.get(id);
    if (!rec) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "scorecard not found.");
    const children = this.deps.runStore ? await this.deps.runStore.list(ctx.tenant, { scorecardId: id }) : [];
    // WHICH CHILD IS THE CASE'S ANSWER (review 39 P0). The receipt says which attempt earned the commit; the
    // fallback — largest updatedAt — answers which row was touched last, which is a different question and was
    // the only one this could ask. Per case, so a batch that predates receipts still resolves the old way.
    // No `.catch(() => [])`: a receipt read that fails must fail THIS finalize (the workflow retries it),
    // not quietly report every case as uncommitted — which either re-dispatched a finished batch or threw a
    // batch-wide missing-case error over a transient read (review 40 P0).
    const committed = (await this.deps.caseReceipts?.list(id)) ?? [];
    const latest = ScorecardBatch.canonicalChildPerCase(children, committed);
    const order = new Map([...ctx.caseIndex.keys()].map((cid, i) => [cid, i] as const));
    const results = [...latest.values()]
      .map((c) => c.result)
      .filter((r): r is CaseResult => r !== undefined)
      // …then by trial, so a pass@k batch's results read in the order it dispatched them rather than in
      // whichever order the ledger happened to hand back rows sharing one case id.
      .sort((a, b) => (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0) || (a.trial ?? 0) - (b.trial ?? 0));
    // A FILTER IS NOT AN ACCOUNTING (arch-review 38 P0). `filter(r => r !== undefined)` silently turns "this
    // case has no result on the ledger" into "this batch has fewer cases", and the Temporal driver then
    // summarized, scored and settled SUCCEEDED over the remainder. Every earlier fix in this file protects the
    // case that WAS written; this is the one that notices a case that was not.
    //
    // The expected set is the plan's, which the workflow drives case by case: a batch whose children do not
    // account for it is unfinished, not smaller. Failing here leaves it open for recovery — the same choice
    // the in-process loop makes for an unwritten case.
    // …AND THE LEDGER IS THE ONLY WITNESS (review 39 P0-3/P0-5). This asked `doneIds` first — a set in THIS
    // process's memory, marked by the activity that ran the case. So a case whose child commit was refused or
    // failed, and which nevertheless marked itself done, passed the very check that exists to catch it; and a
    // rebuilt context (another worker, a restart) has an empty set, which made the same batch answer
    // differently depending on where the finalizer happened to run. A case is accounted for when a row on the
    // ledger carries its result, and by nothing else.
    const plan = this.planItems(ctx);
    const missing = plan.map(encodeCaseKey).filter((key) => !latest.get(key)?.result);
    if (missing.length > 0)
      throw new InternalError(
        "UPSTREAM_ERROR",
        { scorecard: id, missing: missing.slice(0, 20), count: missing.length },
        `${missing.length} case(s) have no result on the ledger — the batch cannot be summarized over the ones that do`,
      );
    // …AND THE RECEIPT SET IS EXACTLY THE PLAN'S (arch-review 41 P1). The check above notices a planned case
    // the ledger cannot answer; this one notices the inverse — a receipt the plan never asked for (a stray
    // seed, a case from a superseded plan) — and it compares on the (caseId, trial) axis, which the id-only
    // check drops — and the plan now genuinely carries trials, so a pass@k batch is held to its whole ask
    // rather than to one execution per case.
    const expectedSet = plan.map((key) => ({ caseId: key.caseId, trial: key.trial ?? 0 }));
    const setDelta = ScorecardBatch.caseSetDelta(expectedSet, committed);
    if (setDelta.missing.length > 0 || setDelta.extra.length > 0)
      throw new InternalError(
        "UPSTREAM_ERROR",
        { scorecard: id, missing: setDelta.missing.slice(0, 20), extra: setDelta.extra.slice(0, 20) },
        `the committed receipt set is not the plan's (${setDelta.missing.length} missing, ${setDelta.extra.length} unplanned) — a success may only settle over exactly the case set the submit planned`,
      );
    // …and the LEDGER rows must be the bytes their receipts vouch for (review 40 P0). Checked over the child
    // rows — never the in-memory copies a later offload may touch — and BEFORE anything downstream publishes:
    // counting the right case with another attempt's result is the subtler half of the missing-case defect.
    const receiptByKey = new Map(committed.map((r) => [childKey(r.caseId, r.trial), r] as const));
    // FULL-BYTES comparison, deliberately (arch-review 46 revisiting 41): this gate runs at the SETTLE,
    // which structurally predates any re-score (a re-score requires a settled batch), so the commit-time
    // resultDigest is still the row's whole truth here — scores included — and comparing the observation
    // half only would wave through a tampered score plane no revision owns. The observation digest's job is
    // elsewhere: post-revision readers and the judgment input pin compare on it, where scores legally moved.
    const divergent = [...latest.entries()].filter(([key, child]) => {
      const receipt = receiptByKey.get(key);
      if (receipt === undefined || child.result === undefined) return false;
      return caseResultDigest(child.result) !== receipt.resultDigest;
    });
    if (divergent.length > 0)
      throw new InternalError(
        "UPSTREAM_ERROR",
        { scorecard: id, divergent: divergent.map(([key]) => key).slice(0, 20), count: divergent.length },
        `${divergent.length} case(s) carry a result whose digest is not their receipt's — the batch cannot be summarized over rows the ledger does not vouch for`,
      );
    const scorecard: Scorecard = {
      suiteId: rec.dataset.id,
      harness: `${ctx.harnessId}@${ctx.harnessVersion}`,
      results,
    };
    // No batch-level offload here at all (arch-review 44): these results are CHILD ROWS' copies — this
    // finalize reads nothing else, and it refuses above when a planned case has no child carrying one — so
    // every one of them was offloaded per attempt inside its own commit. The pass was a no-op over bytes
    // that had already moved, and re-running it on rows the ledger has vouched for is worse than useless:
    // it would edit the very copies the digest checks above just compared.
    await this.shared.checkReceiptParity(id, results);
    const summary = summarizeScorecard(scorecard);
    // Read-guarded terminal write, checked BEFORE the artifact/export writes: a supersede that raced the
    // workflow's finalize already settled the record — never revive it to succeeded (first terminal write
    // wins; a replaced batch also skips its notification), and never let the loser overwrite the winner's
    // analysis artifact or export its cases (I7 — the artifact is part of the judgment's record).
    const final = await this.deps.store.get(id);
    const batch = ScorecardBatch.from(final ?? rec);
    if (batch.isTerminal()) {
      this.batchContexts.delete(id);
      return;
    }
    const initialBundle = analysisBundle(
      { scorecardId: id, dataset: `${rec.dataset.id}@${rec.dataset.version}`, harness: scorecard.harness },
      summary,
      results,
      ctx.verdictPolicy,
    );
    // …under a key only THESE bytes can own (review 39 P0-6): a Temporal activity is at-least-once, so two
    // finalizers can freeze a bundle before the ledger decides which one settles.
    //
    // STAGED, NOT PUBLISHED (arch-review 52, Wave 4). This used to be `offloadAnalysis`, which also wrote the
    // MUTABLE current-analysis alias, and it was immediately followed by the trace-sink export — both of them
    // BEFORE the terminal CAS below. A finalizer that lost the settle (the ordinary at-least-once shape this
    // whole file is built around) had by then overwritten the alias a cancelled batch's analysis surface reads
    // and created traces in the tenant's platform that no CAS result can recall. The content-addressed pass
    // key is safe to write early — a loser's object is an orphan nobody references — so what moves across the
    // commit is exactly the two OUTWARD effects, carried by the publication plan.
    const passId = initialPassId(initialBundle);
    const analysis = await stageAnalysis(this.deps, id, initialBundle, passId, results);
    // Judge attribution (judge id → declared model) — best-effort, never a reason for the export to fail.
    // Collected here rather than in the drain: it is a registry read, and the settlement should export under
    // the attribution it decided rather than under a registry that has since moved.
    const judgeModelMap = this.deps.exportResults
      ? await this.scoring.collectJudgeModelMap(ctx.tenant, ctx.judges).catch(() => ({}))
      : undefined;
    const publication = planPublicationOperation({
      scorecardId: id,
      // The revision this settle appends (arch-review 53, Wave C) — the initial batch's is 1.
      scoringRevision: 1,
      bundle: initialBundle,
      staged: analysis,
      passId,
      exports: this.deps.exportResults !== undefined,
      results,
      ...(ctx.traceSink ? { sink: ctx.traceSink } : {}),
      ...(judgeModelMap ? { judgeModels: judgeModelMap } : {}),
      now: this.now(),
    });
    const declared = modelBindingLabel(ctx.harnessSpec?.kind === "command" ? ctx.harnessSpec.model : undefined);
    const judgeModels = await this.scoring.collectJudgeModels(ctx.tenant, ctx.judges, ctx.judge);
    const runIds = [...latest.values()].map((c) => c.id);
    await this.appendBatchStep(id, { phase: "persist", status: "ok", message: "aggregated and persisted (temporal)" });
    // E0 outbox: the completion fact rides the terminal transition (domain-gated on createdBy — the gate the
    // notification path always applied) and persists atomically with the settle; the push after is the latency
    // nudge carrying the same ids (consumer dedup holds).
    // Scoring identity — the INITIAL revision: which judges (the sealed manifest closure when present — it
    // carries the models — else the bare pins) judged which plane. Every later re-score APPENDS; this entry
    // is what its revision numbers count from.
    const scoring = appendScoringRevision(final?.scoring, {
      kind: "initial",
      judges: ExecutionPlan.of(rec).sealedJudges ?? ctx.judges,
      ...(ExecutionPlan.of(rec).sealedJudgeRun ? { judgeRun: ExecutionPlan.of(rec).sealedJudgeRun } : {}),
      results,
      // The revision entry points at its own FROZEN artifact — never the mutable current key (I7).
      ...(analysis.revisionRef ? { analysisRef: analysis.revisionRef } : {}),
      // …and its durable KEY: the ref expires, and artifacts are keyed by the writing PASS now, so the
      // revision number no longer names the object a historical read has to fetch.
      ...(analysis.revisionKey ? { analysisKey: analysis.revisionKey } : {}),
      // WHAT THE JUDGES READ (arch-review 46), against the receipts this finalize already holds — the same
      // `committed` list the divergence check above ran on, so the revision states the input the settle
      // conditioned on rather than a second read of a ledger that can move between them.
      // WHICH INVOCATION AUTHORED EACH JUDGMENT (arch-review 53, Wave D · corrected arch-review 55, Wave 4).
      // The claim is NOT unreachable from here — that was the reasoning, and it wrote receipts naming
      // `judge:<id>#<pass>` while every seal on this lane carries the attempt's ordinal. A commit receipt
      // names the physical attempt it vouches for precisely so a later reader can answer this, so the vector
      // is joined to the SAME ledger row the settle conditions on, through the same owner the judging site
      // called (`judgeClaimOfAttempt`). A receipt whose row records no attempt states no ordinal — the
      // unisolated case, where the judging passed no claim either.
      judgments: judgmentReceiptsFromPlane(results, initialScoringPassId(id), (r) =>
        judgeClaimOfAttempt(receiptByKey.get(childKey(r.caseId, r.trial))?.attemptId),
      ),
      inputObservation: inputObservationOf(results, { kind: "read", receipts: committed }),
      createdAt: this.now(),
      ...(rec.createdBy !== undefined ? { createdBy: rec.createdBy } : {}),
    });
    // THE SETTLE'S FROZEN READ-SET (review 40, the Release pattern): what this finalize read is what its
    // terminal write conditions on and what the record keeps — the summary is auditable against the exact
    // receipts it was computed over, forever.
    const decision = ScorecardBatch.decisionContext(committed, ctx.driverEpoch, expectedSet, scoring.at(-1)?.revision);
    const settlement = batch.succeed(
      {
        summary,
        decision,
        // The stamped-policy verdict aggregate (arch-review 7 §4) — the number release-shaped surfaces read,
        // so the headline's hardcoded authority ladder can never contradict the actual case verdicts.
        verdictSummary: verdictSummaryOf(results, ctx.verdictPolicy),
        // THE WORLD IT RAN IN (arch-review 19 P2) — derived from the cases' own execution manifests, so this
        // reports rather than declares, and a batch where nothing recorded a world carries none.
        ...(worldCohortOf(results) ? { world: worldCohortOf(results) } : {}),
        models: scorecardModels(scorecard, declared),
        ...(judgeModels.length > 0 ? { judgeModels } : {}),
        // The record's download ref is the FROZEN artifact's, not the alias's: the alias does not exist yet
        // (the publisher promotes it after this write commits), and the immutable object is the honest
        // answer to "where is this batch's analysis" in either case.
        ...(analysis.revisionRef ? { analysisRef: analysis.revisionRef } : {}),
        steps: final?.steps ?? [],
        scoring,
        ...(runIds.length > 0 ? { runIds } : { scorecard }),
      },
      this.now(),
    );
    const stampedCompletion = stampFacts(ctx.tenant, settlement.facts, { newId: this.newId, now: this.now });
    // Under the aggregate's terminal fence (arch-review 30 P0). This is the Temporal finalize, and it read
    // the record before doing the work — a user cancel or a supersede landing in between would have been
    // overwritten by a `succeeded` that arrives afterwards, with its completion fact published on top.
    //
    // …AND UNDER THE EPOCH THIS DRIVER HOLDS (arch-review 35 P0). The context has carried a `driverEpoch`
    // since the fence was built and this write — the canonical parent outcome, the one every reader treats
    // as the batch's answer — never proved it. A takeover raises the epoch and leaves the batch OPEN, which
    // is exactly the state `over: "open"` accepts, so a paused finalizer woke up and settled a batch it no
    // longer owned, beating the successor to the outcome. Holding an epoch in a context is not proving one.
    const finalized = await settleScorecard(
      this.deps.store,
      id,
      settlement.patch,
      stampedCompletion.map((f) => f.record),
      {
        over: "open",
        epoch: ctx.driverEpoch,
        expectReceiptCount: decision.receiptCount,
        // …and the outward effects this settlement owes, inserted by the very write that decides it won.
        ...(publication ? { publishOperation: publication } : {}),
      },
    );
    // EVERY EFFECT OF A SETTLEMENT HANGS OFF THE SETTLEMENT THAT COMMITTED (arch-review 31 P2). The facts
    // below the fold already did; the operator time series did not, so a CAS loser could leave a world where
    // the database, the outbox and the live bus all say "this batch did not settle here" while the metrics
    // say it did — a case counted twice, a verdict latency measured against somebody else's clock.
    if (finalized === undefined) {
      this.batchContexts.delete(id);
      return; // the winner publishes, counts and notifies; this attempt does none of the three
    }
    if (stampedCompletion.length > 0) void this.deps.events?.pushPersisted?.(stampedCompletion);
    // …AND ONLY NOW IS ANYTHING PUBLISHED (arch-review 52, Wave 4). The winner drains its own plan inline,
    // holding the exact results the settle counted, which is what keeps the export prompt. A crash between
    // the commit above and this line leaves the plan owed and the reconciler converges it — the effects are
    // no longer this call's to lose. Never a reason for the batch to fail: an unpublished plan stays owed.
    const operations = this.deps.publicationOperations;
    const drained = publication
      ? await drainPublicationOperation(
          { ...this.deps, ...(operations ? { operations } : {}) },
          finalized,
          publication,
          results,
          this.deps.publisherId ?? "publisher",
          this.now,
        ).catch((): PublicationOutcome => ({ kind: "owed", reason: "publication drain threw" }))
      : ({ kind: "skipped" } as PublicationOutcome);
    if (drained.kind === "owed")
      await this.appendBatchStep(id, {
        phase: "export",
        status: "info",
        message: `Publication still owed — ${drained.reason} (the reconciler will retry)`,
      });
    // Operator time series (catalog M0) — the Temporal driver settles through the SAME derivation as the
    // in-process loop (batchSettledEvent), so the two paths cannot drift.
    this.deps.onOrchestrationEvent?.(
      batchSettledEvent(ctx.tenant, rec.createdAt, scorecard, rec.requested, Date.parse(this.now()), ctx.verdictPolicy),
    );
    this.batchContexts.delete(id);
    if (this.deps.onComplete) {
      const done = await this.deps.store.get(id);
      if (done) await this.deps.onComplete(ctx.tenant, done).catch(() => {});
    }
  }
}
