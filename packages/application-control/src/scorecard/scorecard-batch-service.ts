import {
  BadRequestError,
  type CaseJob,
  type CaseKey,
  type CaseResult,
  ConflictError,
  type Dataset,
  type HarnessSpec,
  type JudgeRunConfig,
  type ScorecardRecord,
  type ScorecardStep,
  UpstreamError,
} from "@everdict/contracts";
import {
  type CircuitBreaker,
  ScorecardBatch,
  applyGradingPlan,
  billingCharges,
  selectSubsetCases,
} from "@everdict/domain";
import { childKey } from "@everdict/domain";
import { resolveCaseEnvironments } from "../environment/case-environment.js";
import { jobAttemptId } from "../execution/open-physical-attempt.js";
import type { ScoringService } from "../execution/scoring-service.js";
import type { SpilloverOutcome } from "../ops/runtime-spillover.js";
import type { DriverAuthority } from "../ops/startup-recovery.js";
import type { ResumeResult } from "../run/run-service.js";
import type { BatchDriverShared } from "./batch-driver-shared.js";
import { CaseOutcomeCommitter } from "./case-outcome-committer.js";
import { ExecutionPlan } from "./execution-plan.js";
import { InProcessBatchDriver, type TrackOptions } from "./in-process-batch-driver.js";
import { RecoveryPlanner } from "./recovery-planner.js";
import { ResilientCaseRunner } from "./resilient-case-runner.js";
import { RetryFailedBatch } from "./retry-failed-batch.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";
import { embedHarnessSpec } from "./scorecard-plan.js";
import { WorkflowBatchDriver } from "./workflow-batch-driver.js";

// Batch-orchestration collaborator behind the ScorecardService facade (docs/architecture/api-route-modularization.md
// R2-b): the live batch lifecycle — restart resume, the retry-failed lineage, and the two drivers that actually
// run a batch (the in-process fan-out loop and the Batch-on-Temporal internals). Composed only by the facade;
// shared plumbing (ids/clock/scoring/breaker/inFlight) is handed in so behavior is identical to the pre-split
// single class.
//
// WHAT THIS OBJECT IS NOW: the composition point, not the driver. Each driver owns its own file
// (`in-process-batch-driver.ts` · `workflow-batch-driver.ts`), the per-case resilience machinery they share
// is a collaborator (`resilient-case-runner.ts`), and what stays here is exactly what BOTH of them ask of
// the batch — the authority probe, the shard history, the envelope, the speculation meters, the
// ledger↔receipt parity statement — handed down as one `BatchDriverShared` bag so a fix cannot reach one
// driver and miss the other.
//
// The pinned model DOCUMENTS a manifest sealed, in the shape the job carries (arch-review 19 P0-4). Absent
// when nothing was pinned — a raw string binding, an unregistered model, or a batch sealed before pins — which
// the dispatcher reads as "unverifiable", never as agreement.

const UNRESUMABLE: ResumeResult = { kind: "unresumable" };

export class ScorecardBatchService {
  private readonly now: () => string;
  // Runtime health memory for sharded-batch spillover (docs/architecture/batch-resilience.md).
  // WHERE A CASE ENDS, for both drivers (arch-review 47 §4). The commit point — judge coverage, evidence
  // assembly, receipt, the child's one terminal write, the attempt's terminal stamp — is this collaborator's,
  // and every path that finalizes a case goes through it. Stateless per batch by construction: the pending
  // and failure maps a track loop keeps are handed to it as arguments (arch-review 34 P0).
  private readonly commit: CaseOutcomeCommitter;
  // WHAT A RE-DRIVE MUST NOT RUN AGAIN (arch-review 47 §4). The resume seeding, the adoption of the
  // mid-flight children a dead process left behind, and the rebuilt context's done-set — one
  // collaborator, because all three stand on the same rule: the receipt says which attempt answered.
  private readonly recovery: RecoveryPlanner;
  // How ONE case physically runs, for both drivers — spillover · OOM boost · speculation, and the fresh
  // attempt every internal re-dispatch opens.
  private readonly cases: ResilientCaseRunner;
  // What the two drivers stand on, built once (see BatchDriverShared).
  private readonly driverShared: BatchDriverShared;
  // The Batch-on-Temporal internals — one instance, because the per-batch context map it keeps is exactly
  // the cache the workflow re-attaches to after a control-plane restart.
  private readonly workflow: WorkflowBatchDriver;
  // A terminal batch's successor (retry-failed), which produces a batch for whichever driver is configured.
  private readonly retry: RetryFailedBatch;

  constructor(
    private readonly deps: ScorecardBatchDeps,
    shared: {
      newId: () => string;
      now: () => string;
      concurrency: number;
      scoring: ScoringService;
      breaker: CircuitBreaker;
      inFlight: Map<string, AbortController>;
      getRecord: (id: string) => Promise<ScorecardRecord | undefined>;
    },
  ) {
    this.now = shared.now;
    this.commit = new CaseOutcomeCommitter(deps, { newId: shared.newId, now: shared.now });
    this.recovery = new RecoveryPlanner(deps, shared.scoring, this.commit, { now: shared.now });
    this.cases = new ResilientCaseRunner(deps, shared.breaker, this.commit);
    // Bound as closures rather than passed as method references: every one of these is a question about the
    // batch that the facade answers, and the drivers must ask it exactly the way the other one does.
    this.driverShared = {
      newId: shared.newId,
      now: shared.now,
      scoring: shared.scoring,
      breaker: shared.breaker,
      inFlight: shared.inFlight,
      commit: this.commit,
      cases: this.cases,
      recovery: this.recovery,
      holdsBatch: (id, epoch) => this.holdsBatch(id, epoch),
      shardHistory: (tenant, harnessId, harnessVersion, targets) =>
        this.shardHistory(tenant, harnessId, harnessVersion, targets),
      childEnvelope: (record) => this.childEnvelope(record),
      meterLostAttempt: (tenant, outcome, caseId, id) => this.meterLostAttempt(tenant, outcome, caseId, id),
      stampLostBranch: (lostJob, caseId) => this.stampLostBranch(lostJob, caseId),
      checkReceiptParity: (id, counted) => this.checkReceiptParity(id, counted),
      writeBackResults: (id, caseToChild, results, parentDriver) =>
        this.writeBackResults(id, caseToChild, results, parentDriver),
    };
    this.workflow = new WorkflowBatchDriver(deps, this.driverShared);
    this.retry = new RetryFailedBatch(deps, {
      newId: shared.newId,
      now: shared.now,
      concurrency: shared.concurrency,
      scoring: shared.scoring,
      commit: this.commit,
      getRecord: shared.getRecord,
      childEnvelope: (record) => this.childEnvelope(record),
      track: (...args) => this.track(...args),
    });
    // ── A LEDGER WITH NO COMMIT POINT CANNOT SAY WHICH ATTEMPT ANSWERED (review 39, Phase 4) ─────────
    //
    // Canonicality is the receipt's, and the "largest updatedAt" fallback is gone — so a composition that
    // writes child rows without a place to commit them has no way to tell a case's answer from a superseded
    // attempt's, and would re-run finished cases on every resume. That is a wiring mistake, not a mode, and
    // it is refused here rather than discovered as a batch that never converges.
    if (deps.runStore && !deps.caseReceipts)
      throw new BadRequestError(
        "BAD_REQUEST",
        { missing: "caseReceipts" },
        "A runStore was wired without caseReceipts: a case's canonical outcome is its commit receipt, so child rows with nowhere to commit cannot be told apart from superseded attempts. Wire caseReceipts (InMemoryCaseReceiptStore in dev/tests, PgCaseReceiptStore in production).",
      );
  }

  // Runtime speed signal from history — RELATIVE, not absolute. Absolute per-runtime medians keyed by harness
  // id confound the signal: v5 sleeps 3s and v8 sleeps 25s, so whichever runtime happened to run the heavier
  // VERSION reads as "slow" (found live: the weighted split inverted). Only batches that themselves spanned ≥2
  // of the current targets carry cross-runtime information; within each, per-target medians are normalized by
  // that batch's mean, and the ratios aggregate across batches — version/workload differences cancel out.
  // The speculation seed needs an ABSOLUTE ms value instead, so it comes only from same id@version batches.
  private async shardHistory(
    tenant: string,
    harnessId: string,
    harnessVersion: string,
    targets: string[],
  ): Promise<{ ratios: Map<string, number>; seedMedianSec?: number }> {
    const ratios = new Map<string, number>();
    let seedMedianSec: number | undefined;
    if (!this.deps.runStore) return { ratios };
    try {
      const past = (await this.deps.store.list(tenant, { status: "succeeded", harness: harnessId })).slice(0, 8);
      const ratioSamples = new Map<string, number[]>();
      const seedDurations: number[] = [];
      const median = (xs: number[]): number | undefined => {
        if (xs.length === 0) return undefined;
        const sorted = [...xs].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      };
      for (const rec of past) {
        const children = await this.deps.runStore.list(tenant, { scorecardId: rec.id });
        const byTarget = new Map<string, number[]>();
        for (const c of children) {
          if (c.status !== "succeeded" || !c.result) continue;
          const d = (new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime()) / 1000;
          if (d <= 0) continue;
          if (rec.harness.version === harnessVersion) seedDurations.push(d);
          if (!c.runtime || !targets.includes(c.runtime)) continue;
          const xs = byTarget.get(c.runtime) ?? [];
          xs.push(d);
          byTarget.set(c.runtime, xs);
        }
        if (byTarget.size < 2) continue; // a single-runtime batch has no cross-runtime signal
        const perTarget = [...byTarget.entries()]
          .map(([t, xs]) => [t, median(xs)] as const)
          .filter((e): e is readonly [string, number] => e[1] !== undefined);
        const mean = perTarget.reduce((a, [, m]) => a + m, 0) / perTarget.length;
        if (mean <= 0) continue;
        for (const [t, m] of perTarget) {
          const xs = ratioSamples.get(t) ?? [];
          xs.push(m / mean);
          ratioSamples.set(t, xs);
        }
      }
      for (const [t, xs] of ratioSamples) {
        const m = median(xs);
        if (m !== undefined) ratios.set(t, m);
      }
      seedMedianSec = median(seedDurations);
    } catch {
      // history is an optimization — never let it break a submit
    }
    return { ratios, ...(seedMedianSec !== undefined ? { seedMedianSec } : {}) };
  }

  // Restart resume — re-drive an interrupted (queued/running) batch from where it stopped: keep the child runs that
  // finished (status=succeeded with a stored result), re-dispatch everything else. Boot recovery calls this instead of
  // tombstoning the batch. Returns false when the record can't be faithfully resumed (no orchestration field — pre-mig
  // records — or the dataset/subset no longer resolves); the caller falls back to the old INTERRUPTED tombstone.
  // docs/architecture/batch-resilience.md
  // `authority` is what the recovery WON when it claimed this batch (arch-review 32 P0). It is threaded to
  // `track` and never re-derived: a replica that reads the row for its epoch reads whatever number the
  // replica that displaced it wrote, and then drives beside it holding an identical token. Absent = nobody
  // claimed anything (a manual re-drive in a single-replica install), which drives under the record's own.
  // ── IT ANSWERS WHICH KIND OF "NO" (arch-review 55) ────────────────────────────────────────────────
  //
  // This returned `boolean`, and the sweep above it read `false` as "tombstone this batch as INTERRUPTED".
  // The `false`s below are genuine permanent refusals — the record is gone, the batch is not resumable, the
  // dataset or harness no longer resolves — but the SAME value was produced by anything that threw inside,
  // including a ledger read that only failed to answer. So a transient outage was written into history as an
  // evaluation that failed, over managed jobs that were still running.
  async resume(id: string, authority?: DriverAuthority): Promise<ResumeResult> {
    // What this resume may do to the batch AND to its children (arch-review 33 P0). The preprocessing below
    // touches children BEFORE `track` proves anything, so without carrying the parent's token down here a
    // replica displaced from the batch could still adopt and tombstone its successor's children — each write
    // clearing a CHILD fence that the parent's takeover never moved.
    //
    // Absent authority = a manual re-drive with no claim behind it, which drives under whatever the record
    // says: the same fallback `track` uses, and the one a single-replica install has always had.
    const parentDriver = authority === undefined ? undefined : { scorecardId: id, epoch: authority.epoch };
    const rec = await this.deps.store.get(id);
    if (!rec) return UNRESUMABLE;
    const batch = ScorecardBatch.from(rec);
    const orch = rec.orchestration; // local narrow — canResume() already requires it
    if (!batch.canResume() || !orch) return UNRESUMABLE;
    // A Temporal-owned batch owns itself: the workflow's activity retries ride out a control-plane restart, so
    // boot recovery must neither tombstone nor double-drive it.
    if (batch.isWorkflowOwned()) return { kind: "resumed" };
    // A MULTI-TRIAL BATCH IS RESUMABLE (arch-review 52, wave 1). It used to fall to the INTERRUPTED tombstone
    // — a control-plane restart threw away every committed trial of a pass@k run and told the submitter their
    // batch was interrupted, because the exclusion downstream was stated in case ids and a case is not the
    // unit a trialled batch executes. It is now stated in (case, trial): the seeds already come one per
    // committed child (the receipt ledger's own unit), and the fan-out skips exactly those.
    // docs/architecture/trial-based-verdict.md
    // ONE plan, consumed many times (arch-review 21). Every facet this batch sealed is asked of the plan
    // rather than re-read off the manifest per call site — which is how a sealed facet used to reach one
    // execution path and not the other.
    const plan = ExecutionPlan.of(rec);
    let dataset: Dataset;
    let seed: CaseResult[] = [];
    let seedRunIds: string[] = [];
    let adopted = 0;
    try {
      const resolved = await this.deps.datasets.get(rec.tenant, rec.dataset.id, rec.dataset.version);
      // Re-apply the recorded selection — ids/tags/limit selection is deterministic, so the same knobs give the same cases.
      const { cases } = selectSubsetCases(
        resolved,
        rec.subset ? { ids: rec.subset.ids, tags: rec.subset.tags, limit: rec.subset.limit } : undefined,
      );
      // …and the SEALED SELECTION AND DOCUMENTS, on the same terms as every other execution path
      // (arch-review 18 P0-2). Resume verified the harness and not the dataset while the Temporal plan
      // verified the dataset and not the harness — each covering the half the other missed, which is worse
      // than either alone because both looked like they had been handled. Resume is also the path where a
      // shadow does the most damage: finished cases are kept, so one scorecard would carry cases evaluated
      // under two different datasets.
      plan.assertSelection(cases);
      // Re-apply the recorded grading plan — resume must score exactly like the original submit.
      // …and the environments this batch SEALED, re-resolved at the pinned versions (§2). A resumed batch
      // that re-read `latest` would finish its remaining cases in a world its finished ones never saw.
      const graded = applyGradingPlan(cases, orch.graders);
      const environments = await resolveCaseEnvironments({
        tenant: rec.tenant,
        cases: graded,
        ...(this.deps.environments ? { registry: this.deps.environments } : {}),
        ...(plan.sealedEnvironments ? { sealed: plan.sealedEnvironments } : {}),
      });
      dataset = { ...resolved, cases: environments.cases };
      // The finished cases this batch already answered, and the mid-flight children a dead process left
      // behind — one collaborator, because both answers stand on the same rule (see RecoveryPlanner).
      const seeded = await this.recovery.seedFromLedger({
        scorecardId: id,
        tenant: rec.tenant,
        dataset,
        judges: orch.judges,
        ...(plan.sealedJudges ? { sealedJudges: plan.sealedJudges } : {}),
        ...(rec.runtime !== undefined ? { runtime: rec.runtime } : {}),
        ...(rec.createdBy !== undefined ? { createdBy: rec.createdBy } : {}),
        ...(parentDriver ? { parentDriver } : {}),
        // …publishable only while this recovery still holds the batch it is recovering.
        ...(parentDriver ? { holdsBatch: () => this.holdsBatch(id, parentDriver.epoch) } : {}),
      });
      seed = seeded.seed;
      seedRunIds = seeded.seedRunIds;
      adopted = seeded.adopted;
    } catch (err) {
      // WHICH failure this was decides whether history records a verdict. A plan that cannot be MADE because
      // the ledger could not be read is `retry_later`; one that cannot be made because the dataset no longer
      // resolves is permanent. `seedFromLedger` says which by returning rather than throwing for the first.
      if (err instanceof UpstreamError) return { kind: "retry_later", reason: err.message };
      return UNRESUMABLE; // dataset/subset no longer resolves — not faithfully resumable
    }
    // Harness spec re-resolve at the recorded concrete version (+ the recorded ephemeral pins, if any).
    let harnessSpec: HarnessSpec | undefined;
    const pins = rec.origin?.pinOverrides;
    if (this.deps.harnesses) {
      const harnesses = this.deps.harnesses;
      // Registered → embed the resolved spec; unregistered/built-in (NotFound) → no spec embedded (as at submit). A
      // registered-but-invalid spec throws rather than re-dispatching specless (resume's caller absorbs the throw).
      const resolvedSpec = await embedHarnessSpec(
        () =>
          pins && Object.keys(pins).length > 0
            ? harnesses.resolveWithPins(rec.tenant, rec.harness.id, rec.harness.version, pins)
            : harnesses.get(rec.tenant, rec.harness.id, rec.harness.version),
        { id: rec.harness.id, version: rec.harness.version },
      );
      // A REFUSAL IS A REFUSAL, whichever document moved (arch-review 19). The dataset half answers `false`
      // — "not faithfully resumable" — because that is what this method returns; the harness half was added
      // outside that try and threw instead, so the same fact left the same method two different ways
      // depending on which document was shadowed. That is the asymmetry class this area keeps producing, in
      // miniature. Recovery treats both as "cannot resume", and the marker stays for an operator.
      try {
        plan.assertHarness(resolvedSpec);
      } catch (err) {
        if (err instanceof ConflictError) return UNRESUMABLE;
        throw err;
      }
      harnessSpec = plan.pinSpec(resolvedSpec);
    }
    // Counted in EXECUTIONS, not cases — a trialled batch's ask is cases × trials, and the note is what a
    // submitter reads to know how much of their run survived the restart.
    const remaining = dataset.cases.length * Math.max(1, orch.trials ?? 1) - seed.length;
    void this.track(
      id,
      rec.tenant,
      rec.createdBy ?? rec.tenant,
      dataset,
      rec.harness.id,
      rec.harness.version,
      harnessSpec,
      orch.judges,
      rec.runtime,
      orch.judge,
      orch.concurrency,
      {
        seed,
        seedRunIds,
        retries: orch.retries,
        // The batch's OWN trial count — without it a resumed pass@k batch re-drove its remainder as
        // single-trial, which is a different experiment from the one the submitter asked for.
        ...(orch.trials !== undefined && orch.trials > 1 ? { trials: orch.trials } : {}),
        ...(plan.sealedJudges ? { sealedJudges: plan.sealedJudges } : {}),
        ...(plan.modelPins ? { modelPins: plan.modelPins } : {}),
        ...(orch.traceSink ? { sinkOverride: orch.traceSink } : {}),
        ...(orch.oomAutoBoost ? { oomAutoBoost: true } : {}),
        ...(authority ? { authority } : {}),
        resumeNote: `Resumed after a control-plane restart — ${seed.length} finished case(s) kept, ${remaining} re-dispatched${adopted > 0 ? ` (${adopted} in-flight job(s) adopted without re-running)` : ""}`,
      },
    );
    return { kind: "resumed" };
  }

  // ── THE DRIVERS, ADDRESSED BY THE FACADE'S OWN SURFACE ─────────────────────────────────────────────
  //
  // The four verbs below are unchanged for every caller (ScorecardService, the internal Temporal routes,
  // the retry lineage); what changed is that the code behind them lives in the driver that owns it.

  // The in-process fan-out loop: ONE driver instance per batch, so the loop's bookkeeping cannot outlive
  // the batch it belongs to (arch-review 34 — the cross-batch pending map).
  async track(
    id: string,
    tenant: string,
    owner: string, // submitter subject — for resolving private-repo case tokens (personally-owned connection)
    dataset: Dataset,
    harnessId: string,
    harnessVersion: string,
    harnessSpec: HarnessSpec | undefined,
    judges: Array<{ id: string; version: string }>,
    runtime: string | undefined,
    judge: JudgeRunConfig | undefined,
    concurrency: number, // number of cases to dispatch concurrently (request override→service default is resolved in submit).
    opts: TrackOptions = {},
  ): Promise<void> {
    return new InProcessBatchDriver(this.deps, this.driverShared, {
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
    }).run();
  }

  // Batch-on-Temporal — plan the remaining work, run one case, aggregate + settle. See WorkflowBatchDriver.
  planBatch(id: string): Promise<{ caseIds: string[]; items: CaseKey[]; concurrency: number }> {
    return this.workflow.planBatch(id);
  }

  runBatchCase(id: string, caseId: string, trial?: number): Promise<{ settled: boolean; skipped?: boolean }> {
    return this.workflow.runBatchCase(id, caseId, trial);
  }

  finalizeBatch(id: string): Promise<void> {
    return this.workflow.finalizeBatch(id);
  }

  // Retry-failed — a NEW scorecard that re-runs only the failed cases of a terminal batch. See RetryFailedBatch.
  retryFailed(input: {
    tenant: string;
    id: string;
    submittedBy?: string;
    failureClass?: "infra" | "config" | "harness" | "agent";
  }): Promise<ScorecardRecord> {
    return this.retry.run(input);
  }

  // The batch's progress timeline, appended through the per-batch context that serializes concurrent
  // appends — the workflow driver owns that map, so both drivers write the timeline the same way.
  private appendBatchStep(id: string, step: Omit<ScorecardStep, "ts">): Promise<void> {
    return this.workflow.appendBatchStep(id, step);
  }

  // The same question with no fan-out to stop: does this loop still hold the batch? Asked once more AFTER a
  // case executes and BEFORE its evidence is published (arch-review 33). The seal is what makes this matter:
  // a trajectory keeps its FIRST segment per emitter, so a driver displaced mid-case that seals anyway plants
  // the permanent execution plane of a case whose settle is about to be refused — and the successor's
  // re-drive, which produces the result the child actually keeps, then loses its own seal as a re-offer.
  // `result = B, trajectory = A`, one level below where that sentence was first fixed.
  private async holdsBatch(id: string, epoch: number): Promise<boolean> {
    const held = await this.deps.store
      .update(id, { updatedAt: this.now() }, undefined, { expectOwnerEpoch: epoch, expectNonTerminal: true })
      .catch(() => undefined);
    return held !== undefined;
  }

  // ── THE LEDGER AND THE RECEIPTS MUST AGREE (review 39, Phase 1 parity) ───────────────────────────────
  //
  // Both are being written while the cutover is in progress: the parent still aggregates the children it can
  // see, and the receipts record which attempt was entitled to be counted. A disagreement means the summary
  // was built over a different set of executions than the one that committed — the exact defect that
  // "latest updatedAt wins" makes invisible — so it is STATED on the batch's own step timeline rather than
  // resolved silently in favour of whichever half the reader happens to trust.
  //
  // It never fails the batch. With no receipt store wired there is nothing to compare, and a comparison that
  // cannot be made is not a mismatch.
  private async checkReceiptParity(id: string, counted: CaseResult[]): Promise<void> {
    const receipts = this.deps.caseReceipts;
    if (!receipts) return;
    try {
      const committed = await receipts.list(id);
      if (committed.length === 0) return; // nothing claimed (a batch that predates the store) — nothing to say
      // Failures included: the failure exit commits a receipt too (review 40 P0), so a counted failure with
      // no receipt is exactly the disagreement this exists to surface. The DIGESTS are not compared here —
      // they are enforced at the gates (resultsFromLedger / the finalize divergence check), which own the
      // question and answer it against the ledger's own bytes. A key-set comparison is the part memory can
      // still be trusted with: which cases this process counted, not what it thinks they contain.
      const ledgerKeys = new Set(counted.map((r) => childKey(r.caseId, r.trial)));
      const receiptKeys = new Set(committed.map((r) => childKey(r.caseId, r.trial)));
      const uncounted = [...receiptKeys].filter((k) => !ledgerKeys.has(k));
      const unclaimed = [...ledgerKeys].filter((k) => !receiptKeys.has(k));
      if (uncounted.length === 0 && unclaimed.length === 0) return;
      await this.appendBatchStep(id, {
        phase: "persist",
        status: "info",
        message: `receipt parity: ${uncounted.length} committed case(s) not counted, ${unclaimed.length} counted case(s) with no receipt`,
      });
    } catch {
      // A parity read that fails says nothing about the batch — it is a diagnostic, and a diagnostic that
      // breaks the thing it observes is worse than no diagnostic.
    }
  }

  // ── THE LOSER OF A RACE STILL SPENT (review 39 P0) ───────────────────────────────────────────────────
  //
  // Tail speculation keeps the first success and drops the other, which is correct for the VERDICT — a case
  // has one answer — and wrong for the money: the duplicate ran on the tenant's infrastructure and its
  // provider key, and its cost simply vanished. Usage and the enforcement budget were therefore both computed
  // over a smaller execution set than the one that happened, which is the same "canonical verdict is one,
  // physical spend is many" confusion the receipt draws the line for on the evidence side.
  //
  // Metered, never scored: this touches the usage/budget ledgers and nothing that answers "how did the agent
  // do". `evaluations` is deliberately left out of the count — a loser is spend, not an evaluation.
  // A speculation branch that REJECTED while its sibling answered the case (arch-review 51 residue): the
  // branch's attempt row would otherwise stand non-terminal forever — the failure exit stamps only the
  // attempt the CASE dies with, and a branch whose error was absorbed by a sibling's success never reaches
  // it. `failed` because it physically failed; best-effort, and idempotent against the ledger's terminal
  // guard (an overlap with the case's own failure stamp is a silent no-op).
  private stampLostBranch(lostJob: CaseJob, caseId: string): void {
    const executionId = lostJob.runId;
    if (executionId === undefined) return;
    void this.commit.stampAttempt(jobAttemptId(lostJob, executionId), "failed", {
      error: {
        code: "SPECULATION_BRANCH_FAILED",
        message: `the speculation branch for ${caseId} failed while a sibling answered the case`,
      },
    });
  }

  private meterLostAttempt(tenant: string, outcome: SpilloverOutcome, caseId: string, id: string): void {
    const result = outcome.result;
    // …and the PHYSICAL ledger records that this execution stopped being the case's (arch-review 51). The
    // duplicate opened its own attempt row (see reattemptOf) and nothing ever ended it: the loser of a race
    // it lost stood `executing` for ever beside the winner's committed row. Superseded, not failed — it ran
    // to completion, it simply is not the answer. Best-effort, like every stamp with no transaction to ride.
    const executionId = outcome.job.runId;
    if (executionId !== undefined)
      void this.commit.stampAttempt(jobAttemptId(outcome.job, executionId), "superseded", {
        error: { code: "SPECULATION_LOST", message: "a concurrent attempt answered the case first" },
      });
    let usd = 0;
    for (const charge of billingCharges(result, tenant)) {
      this.deps.budget?.settle(charge.tenant, charge.cost);
      this.deps.usage?.record(charge.tenant, charge.source, charge.model, charge.cost, 0);
      usd += charge.cost.usd;
    }
    if (usd <= 0) return; // a duplicate that spent nothing measurable is not worth a line on the timeline
    void this.appendBatchStep(id, {
      phase: "case",
      status: "info",
      message: `${caseId}: speculation loser billed ($${usd.toFixed(4)}) — its result is not the case's answer`,
      caseId,
    });
  }

  // Reflect the case results finalized by batch judge/offload into each child run (since we don't store the embed, get's hydration source must be current).
  // Update each result onto its run via the caseId → childId mapping. This is the authoritative final write, so it also
  // seals the replay recording teed under each child's runId and attaches the ref (best-effort). docs/architecture/replay.md.
  private async writeBackResults(
    scorecardId: string,
    caseToChild: Map<string, string>,
    results: CaseResult[],
    // The batch driver this write-back belongs to. A terminal child's PAYLOAD is as much the settlement as
    // its status is, and this amendment is the one path that could still change it (arch-review 35 P0).
    parentDriver?: { scorecardId: string; epoch: number },
  ): Promise<void> {
    const store = this.deps.runStore;
    if (!store) return;
    for (const r of results) {
      const childId = caseToChild.get(childKey(r.caseId, r.trial));
      if (!childId) continue;
      // The recording is NOT sealed here any more (arch-review 37). Assembly belongs to the case's own
      // terminal write — `assembleCaseEvidence` folds and seals under the attempt that produced it — and a
      // second seal at write-back time would be a post-terminal amendment carrying no attempt at all, which
      // is the shape every fence in this file exists to refuse.
      // The payload half of "first terminal write wins" (arch-review 25 P1). A case already past the point of
      // no return when the batch was stopped still comes back with a result; writing it onto the cancelled
      // child produced a row saying `status: cancelled` and `result: success` at the same time.
      // A TERMINAL CAS WON IS NOT A TERMINAL PAYLOAD IMMUTABLE (arch-review 35 P0). Every terminal write on a
      // child proves the child's epoch AND the parent's driver — and then this amendment ran with neither,
      // so a driver that LOST the settle could still land its result on the row afterwards: the winner's
      // status beside the loser's evidence, which is the same `parent judgment = B, child evidence = A` split
      // three reviews have now chased through four different artifacts.
      //
      // `expectNotCancelled` stays: a case past the point of no return when the user stopped the batch must
      // not have its cancellation overwritten by the result it produced anyway. It was never the whole
      // condition, only the half that had a name.
      // ── AND A TERMINAL PAYLOAD IS NOT AMENDED AT ALL (review 39 P1) ────────────────────────────────
      //
      // Even under the right driver, this rewrote the RESULT of a child that had already published one. The
      // fence made the amendment the current owner's to make; it did not ask whether an amendment should
      // exist. It should not: the case's evidence is assembled and its judges are applied BEFORE its one
      // terminal write now (`settleJudgedChild`), so anything this would change is a second version of a fact
      // a reader may already have fetched — and a crash between the two versions leaves the ledger holding
      // whichever half landed first.
      //
      // What remains is filling a HOLE: a child that settled with no result at all (the failure/partial path
      // writes results onto children the loop never got to settle). So the write is conditional on the row
      // having none, which is the difference between completing a record and revising one.
      // The read is only a cheap skip; the CONDITION travels with the write (expectNoResult, arch-review
      // 46) — a result landing between the two refuses this statement instead of being restated over.
      const current = await store.get(childId);
      if (current?.result) continue; // already published its evidence — this is not ours to restate
      await store.update(childId, { result: r, updatedAt: this.now() }, undefined, {
        expectNoResult: true,
        expectNotCancelled: true,
        ...(parentDriver ? { parentDriver } : {}),
      });
    }
  }

  // The delegated envelope every fan-out child draws from (§5.2, P4): resolved from the batch's causer run
  // (origin.causedByRunId → its envelope, own or inherited). One read; a miss = no envelope (unenforced).
  private async childEnvelope(record: { origin?: { causedByRunId?: string } }): Promise<{ id: string } | undefined> {
    const causerId = record.origin?.causedByRunId;
    if (!causerId || !this.deps.runStore) return undefined;
    const causer = await this.deps.runStore.get(causerId);
    return causer?.envelope ? { id: causer.envelope.id } : undefined;
  }
}
