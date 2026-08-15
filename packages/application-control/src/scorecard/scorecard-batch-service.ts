import {
  AppError,
  AuthorityLostError,
  BadRequestError,
  CURRENT_EVIDENCE_VERSION,
  type CaseCommitReceipt,
  type CaseJob,
  type CaseResult,
  ConflictError,
  type Dataset,
  type DomainFact,
  type EvalCase,
  type ExecutionAttemptState,
  type HarnessSpec,
  InternalError,
  type JudgeRunConfig,
  NotFoundError,
  OOM_KILLED,
  type RunRecord,
  type Scorecard,
  type ScorecardManifest,
  type ScorecardOrigin,
  type ScorecardRecord,
  type ScorecardStep,
  type Suite,
  type VerdictPolicy,
  attemptIdOf,
} from "@everdict/contracts";
import {
  type CircuitBreaker,
  type HarnessSecretMaps,
  Run,
  ScorecardBatch,
  type ScorecardOutcomeExtras,
  billingCharges,
  caseObservationDigest,
  caseOutcome,
  caseResultDigest,
  caseVerdict,
  classifyFailure,
  completeJudgeCoverage,
  contentDigest,
  modelBindingLabel,
  newScorecardChildRun,
  newSeededScorecardChildRun,
  nextScoringRevision,
  resolveHarnessSecrets,
  resolvePolicyResolution,
  runEvidenceIdentity,
  scorecardModels,
  summarizeScorecard,
} from "@everdict/domain";
import {
  appendScoringRevision,
  applyGradingPlan,
  caseReason,
  childKey,
  inputObservationOf,
  isRunTerminal,
  sealedExecutionMessage,
  selectSubsetCases,
  verdictSummaryOf,
  verifySealedSelection,
  worldCohortOf,
} from "@everdict/domain";
import { collectDeferredTrace } from "../execution/collect-trace.js";
import { executeCase } from "../execution/execute-case.js";
import { openPhysicalAttempt } from "../execution/open-physical-attempt.js";
import type { ScoringService, SealedJudgeClosure } from "../execution/scoring-service.js";
import { AdaptiveConcurrencyGate } from "../ops/adaptive-concurrency.js";
import { OOM_ESCALATION_CAP_MB, executeWithOomBoost } from "../ops/oom-boost.js";
import { executeWithSpillover } from "../ops/runtime-spillover.js";
import { weightedTargets } from "../ops/shard-weights.js";
import { SpeculationController } from "../ops/speculation.js";
import type { DriverAuthority } from "../ops/startup-recovery.js";
import { stampFacts } from "../platform-event/outbox.js";
import { offloadSnapshot } from "../ports/artifact-store.js";
import type { DispatchOptions } from "../ports/dispatcher.js";
import type { OutboxEvent, RunStore } from "../ports/run-store.js";
import { settleRun, settleScorecard } from "../ports/settle.js";
import { sealExecutionPlanes } from "../ports/trajectory-store.js";
import { dispatchManifest, foldEnvDeltas } from "../recording-manifest.js";
import { type Dispatch, runSuite } from "../run-suite.js";
import { ExecutionPlan } from "./execution-plan.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";
import {
  analysisBundle,
  batchSettledEvent,
  exportStepMessage,
  initialPassId,
  offloadAnalysis,
  offloadResults,
} from "./scorecard-observability.js";
import { embedHarnessSpec, pinHarnessSpecToClosure } from "./scorecard-plan.js";

// Batch-orchestration collaborator behind the ScorecardService facade (docs/architecture/api-route-modularization.md
// R2-b): the live batch lifecycle — the in-process track loop, the Batch-on-Temporal internals (plan/run/finalize),
// restart resume, and retry-failed. Composed only by the facade; shared plumbing (ids/clock/scoring/breaker/inFlight)
// is handed in so behavior is identical to the pre-split single class.
// The pinned model DOCUMENTS a manifest sealed, in the shape the job carries (arch-review 19 P0-4). Absent
// when nothing was pinned — a raw string binding, an unregistered model, or a batch sealed before pins — which
// the dispatcher reads as "unverifiable", never as agreement.

// The correlation id a case is DISPATCHED with — the key its frames, logs, live trajectory and replay are
// written under. One function, so the id the job carries and the id the child row stamps cannot drift.
function executionIdOf(job: { evalCase: { id: string }; trial?: number; batchId?: string }, batchId?: string): string {
  const parent = job.batchId ?? batchId ?? "";
  return `evd-${parent}-${job.evalCase.id}${job.trial !== undefined ? `-t${job.trial}` : ""}`;
}

// A case whose execution is done and whose child row is deliberately still open until its judges land.
interface PendingChildSettle {
  childId?: string;
  ranOn?: string;
  parentDriver: { scorecardId: string; epoch: number };
  // The id this case was dispatched with — the key its replay buffer is written under (mig 0172) — and the
  // ATTEMPT under that id (mig 0173), which every append and the seal must carry.
  executionId: string;
  // Absent when the attempt never opened one (recording claim refused) — never 0: that sentinel fabricated
  // a `<executionId>#g0` coordinate no ledger mints, and every unisolated case collided on it (review 46).
  generation?: number;
  // This attempt could not isolate its recording buffer — it runs, but its replay is not claimed as ours.
  unisolated?: boolean;
  // The judges this batch SELECTED. Carried so the commit can state the absence of one that never answered
  // rather than leaving the row silent about it (review 39 P0-3) — the same invariant the Temporal path holds.
  judges: ReadonlyArray<{ id: string }>;
  // …and the SEALED closure those judges resolved to at submit (specDigest/model/rubric digests) — what the
  // receipt's judgeClosureDigest names, so "which judgment produced this outcome" is the manifest's answer,
  // not a list of id strings (review 40 follow-up P1).
  sealedJudges?: SealedJudgeClosure[];
}

// A case the in-process loop sent down the FAILURE exit — what the judged exit needs to finalize it
// ATOMICALLY once the failure is known final (arch-review 41 P0-lifecycle). The dispatch catch no longer
// terminalizes the child itself: a retryable throw would re-open the case anyway, and terminal-first left a
// window (terminal child, no receipt) a crash turned into a re-execution and a takeover turned into an
// unfenced claim. The child stays OPEN until the judged exit commits receipt + terminal write in one
// transaction — the same commit point every other outcome uses.
interface FailureFinalization {
  childId?: string;
  executionId: string;
  generation?: number;
  // The batch this attempt ran under — the fence the atomic commit must re-prove inside the transaction.
  parentDriver: { scorecardId: string; epoch: number };
  // What the dispatch could not isolate (see PendingChildSettle.unisolated) — a failure seals no replay then.
  unisolated?: boolean;
  // The failure as the catch saw it — the abandon-settle of a superseded attempt's child needs it verbatim.
  error: { code: string; message: string };
  // The judge selection + sealed closure, same as the judged exit's pending entry: a failure receipt names
  // the judgment identity too (pre-fix it carried no judgeClosureDigest — an asymmetry with no reason).
  judges: ReadonlyArray<{ id: string }>;
  sealedJudges?: SealedJudgeClosure[];
}

export class ScorecardBatchService {
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly concurrency: number;
  private readonly scoring: ScoringService;
  private readonly inFlight: Map<string, AbortController>;
  // M2 dedup — one run.placement_blocked fact per batch (the step timeline keeps every sighting).
  private readonly placementBlockedAnnounced = new Set<string>();
  // Runtime health memory for sharded-batch spillover (docs/architecture/batch-resilience.md).
  private readonly breaker: CircuitBreaker;
  private readonly getRecord: (id: string) => Promise<ScorecardRecord | undefined>;

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
    this.newId = shared.newId;
    this.now = shared.now;
    this.concurrency = shared.concurrency;
    this.scoring = shared.scoring;
    this.breaker = shared.breaker;
    this.inFlight = shared.inFlight;
    this.getRecord = shared.getRecord;
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
  async resume(id: string, authority?: DriverAuthority): Promise<boolean> {
    // What this resume may do to the batch AND to its children (arch-review 33 P0). The preprocessing below
    // touches children BEFORE `track` proves anything, so without carrying the parent's token down here a
    // replica displaced from the batch could still adopt and tombstone its successor's children — each write
    // clearing a CHILD fence that the parent's takeover never moved.
    //
    // Absent authority = a manual re-drive with no claim behind it, which drives under whatever the record
    // says: the same fallback `track` uses, and the one a single-replica install has always had.
    const parentDriver = authority === undefined ? undefined : { scorecardId: id, epoch: authority.epoch };
    const rec = await this.deps.store.get(id);
    if (!rec) return false;
    const batch = ScorecardBatch.from(rec);
    const orch = rec.orchestration; // local narrow — canResume() already requires it
    if (!batch.canResume() || !orch) return false;
    // A Temporal-owned batch owns itself: the workflow's activity retries ride out a control-plane restart, so
    // boot recovery must neither tombstone nor double-drive it.
    if (batch.isWorkflowOwned()) return true;
    // A multi-trial batch keys child runs by (case, trial); the seed path below dedups by caseId, so a faithful
    // resume needs (case, trial) seeding — not yet supported. Fall back to the INTERRUPTED tombstone. docs/architecture/trial-based-verdict.md
    if (batch.isMultiTrial()) return false;
    // ONE plan, consumed many times (arch-review 21). Every facet this batch sealed is asked of the plan
    // rather than re-read off the manifest per call site — which is how a sealed facet used to reach one
    // execution path and not the other.
    const plan = ExecutionPlan.of(rec);
    let dataset: Dataset;
    let seed: CaseResult[] = [];
    const seedRunIds: string[] = [];
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
      dataset = { ...resolved, cases: applyGradingPlan(cases, orch.graders) };
      if (this.deps.runStore) {
        const children = await this.deps.runStore.list(rec.tenant, { scorecardId: id });
        // WHICH child is this case's answer: the receipt, and only the receipt (review 39, Phase 4). A
        // resume that seeded "the newest row" could carry a superseded attempt's result into the rebuilt
        // batch — and a case with no receipt has no answer at all, so it is simply re-dispatched below,
        // which is what an uncommitted case means.
        // No `.catch(() => [])`: a receipt read that fails must fail the resume (it is retried), not read as
        // "nothing committed" — which re-dispatched every finished case of the batch (review 40 P0).
        const committedReceipts = (await this.deps.caseReceipts?.list(id)) ?? [];
        const canonical = ScorecardBatch.canonicalChildPerCase(children, committedReceipts);
        const committedIds = new Set([...canonical.values()].map((c) => c.id));
        // EVERY child is examined, and only the COMMITTED ones are evidence. Two different questions that
        // used to be one: "which row is this case's answer" (the receipt) and "which rows are still running
        // and must be adopted or interrupted" (all of them). Iterating the canonical map alone left a
        // mid-flight child of an uncommitted case untouched — parented to the batch and running forever.
        for (const c of children) {
          // TERMINAL + RESULT IS FINISHED EVIDENCE, whatever the status says (arch-review 30 P1). The
          // symmetric half of "terminal + no result is unfinished work": a case can settle FAILED and still
          // carry a complete CaseResult — the write-back attaches one to a failed child on purpose, because
          // a failed case is a measured outcome, not a missing one. Seeding only `succeeded` re-ran those
          // cases on resume, and the abandoned attempt stayed parented to the batch.
          //
          // …and COMMITTED is now part of that sentence (review 39, Phase 4): a terminal child no attempt
          // committed is a superseded execution, so it is left where it is and its case is re-dispatched.
          if (committedIds.has(c.id) && c.result) {
            seed.push(c.result);
            seedRunIds.push(c.id);
          } else if (c.status === "running" || c.status === "queued") {
            // Mid-flight when the process died. ADOPT first: the orchestrator job the old process submitted may
            // still be running (or already finished) — harvest its result instead of re-dispatching and paying
            // for the same execution twice. Only when nothing is adoptable does the case fall to re-dispatch.
            const adoptable = this.deps.adoptCase
              ? await this.deps.adoptCase(rec.tenant, c.runtime ?? rec.runtime, c.caseId).catch(() => undefined)
              : undefined;
            // A REJECTED TRANSITION IS NOT REJECTED EVIDENCE (arch-review 28 P0). The CAS below correctly
            // refuses to overwrite a child that settled on its own between the list above and this write —
            // and the seed was pushed regardless, so the resumed batch could aggregate the harvested result
            // while the LEDGER held the real one. The two are usually equal and nothing here proves it: the
            // ledger row is what a reader sees a year later, so the ledger row is what the aggregate must be
            // built from.
            //
            // So when the CAS loses, the persisted truth decides — re-read the child and follow it.
            if (adoptable) {
              // WHAT A BACKEND HANDS BACK IS A RECOVERED EXECUTION, NOT FINISHED EVIDENCE (arch-review 34 P0).
              //
              // The in-process loop stopped terminalizing a child before its judges landed, and this branch —
              // the one that runs precisely when a control plane died mid-batch — went on adopting the raw
              // result straight into `succeeded` and seeding it. A seeded case is never re-dispatched and
              // never re-judged, so a batch recovered from a crash could complete with a case that met no
              // judge its own manifest names: no score, and no `unmeasured` row accounting for the absence.
              // The rule "terminal + result = finished evidence" was true again on one path and false on the
              // other, which is how it was wrong the first time.
              //
              // So the judges run here too, over the SAME sealed closure the batch was submitted under, and
              // the child settles with what they produced. Re-judging costs a provider call; seeding
              // unjudged evidence costs a verdict.
              // A JUDGE THAT FAILED AT THE TOP LEVEL IS NOT A JUDGED CASE (arch-review 38 P0). Swallowing it
              // here would terminalize the adopted result as finished evidence with no judge row at all —
              // the very shape re-judging on recovery was introduced to prevent. A per-judge failure still
              // becomes an `unmeasured` row inside the stream; this catch is for the stream itself dying,
              // and then the case is left OPEN for the next attempt rather than sealed as complete.
              let judged = true;
              if (orch.judges.length > 0)
                judged = await this.scoring
                  .applyJudges(
                    rec.tenant,
                    dataset,
                    [adoptable],
                    orch.judges,
                    rec.runtime,
                    rec.createdBy,
                    () => c.id,
                    plan.sealedJudges,
                    // …publishable only while this recovery still holds the batch it is recovering.
                    parentDriver ? () => this.holdsBatch(id, parentDriver.epoch) : undefined,
                  )
                  .then(() => true)
                  .catch(() => false);
              if (!judged) continue; // left active: the resume below re-dispatches it
              // THE SAME TWO INVARIANTS A COMMIT CARRIES ON EITHER DRIVER (review 39). A recovery is a third
              // path to a terminal child, and it held neither: an adopted case could go terminal with a
              // selected judge unmentioned, and with no receipt saying which attempt the batch counted — so
              // the parity check would report every recovered case as a disagreement, which is exactly the
              // kind of noise that makes a diagnostic useless.
              //
              // The evidence assembly is NOT repeated here: this result came back from a backend that
              // produced its own artifacts under an attempt this process never opened, and re-keying them
              // under a generation it would have to invent is worse than leaving them where they are.
              const adoptedResult =
                orch.judges.length > 0
                  ? { ...adoptable, scores: completeJudgeCoverage(adoptable.scores, orch.judges) }
                  : adoptable;
              // ATOMIC, like every other commit (review 40 P0): the claim and the adopt-settle are ONE
              // transaction, so a recovery that lost the child's fence never leaves a receipt naming a child
              // whose adoption was refused. Through the VERB still — `adopt` writes `succeeded` under the
              // child's epoch AND the parent's driver (arch-review 34 P0), re-read inside the transaction so
              // the fence is proven against the row the commit actually lands on. A commit that THROWS
              // leaves the case active — the resume below re-dispatches it, which is the recoverable reading
              // of a store fault.
              const recoveryRuns = this.deps.runStore;
              const adoption = this.deps.caseReceipts
                ? await this.deps.caseReceipts
                    .commitCase(
                      this.receiptOf(id, adoptedResult, {
                        childId: c.id,
                        // An adoption is THIS batch's execution, harvested by recovery — the case ran here
                        // (its dispatch just outlived the driver), so the kind is the run's own outcome.
                        kind: adoptedResult.failure !== undefined ? "failed" : "executed",
                        ...(c.executionId ? { executionId: c.executionId } : {}),
                        judges: orch.judges,
                        ...(plan.sealedJudges ? { sealedJudges: plan.sealedJudges } : {}),
                      }),
                      async (runs) => {
                        const cur = await runs.get(c.id);
                        if (!cur || Run.from(cur).isTerminal()) return undefined;
                        return settleRun(runs, c.id, Run.from(cur).adopt(adoptedResult, this.now()).patch, undefined, {
                          epoch: cur.ownerEpoch ?? 0,
                          ...(parentDriver ? { parentDriver } : {}),
                        });
                      },
                      recoveryRuns,
                    )
                    .catch(() => undefined)
                : undefined;
              if (adoption === undefined) continue; // store fault — left active: the resume below re-dispatches it
              if (adoption.kind === "committed") {
                adopted += 1;
                seed.push(adoptedResult);
                seedRunIds.push(c.id);
                continue;
              }
              // Another attempt owns this case — the recovery does not adopt it.
              if (adoption.kind === "already_committed" && adoption.receipt.childRunId !== c.id) continue;
              // `unsettled` (the child settled on its own between the list and this write — the fence
              // refused, and the claim rolled back with it) or the idempotent re-claim of this very child:
              // the persisted truth decides — re-read the child and follow it.
              const settled = await this.deps.runStore.get(c.id);
              // It finished while we were harvesting: its own result is the evidence, not ours.
              if (settled?.result) {
                seed.push(settled.result);
                seedRunIds.push(c.id);
                continue;
              }
              // TERMINAL WITH NO RESULT IS UNFINISHED WORK, and this is the policy rather than an accident
              // (arch-review 29 P1). A child can settle `failed` carrying nothing — a dispatch that never
              // produced a case result, which is an infrastructure failure and exactly what a resume exists
              // to recover. Seeding nothing leaves the case in `casesToRun`, so it is re-dispatched.
              //
              // The alternative reading — "settled is settled, never re-run it" — would turn every lost
              // sandbox into a permanently unmeasured case, which is the outcome the retry vocabulary was
              // built to avoid. Saying which of the two this is beats leaving it to whichever branch runs.
              continue;
            }
            const interrupted = await settleRun(
              this.deps.runStore,
              c.id,
              Run.from(c).fail(
                { code: "INTERRUPTED", message: "Interrupted by a control-plane restart — re-dispatched on resume." },
                this.now(),
              ).patch,
              undefined,
              // …under the child's own epoch AND the parent's driver: one refuses a child somebody claimed
              // directly, the other refuses a recovery that has lost the batch it is recovering.
              { epoch: c.ownerEpoch ?? 0, ...(parentDriver ? { parentDriver } : {}) },
            );
            if (interrupted === undefined) {
              // The child settled between the read and this write. Marking it INTERRUPTED lost, correctly —
              // and treating it as remaining work would re-run a case that already has an answer, so the
              // persisted answer is seeded instead. A terminal child with no result falls through to the
              // re-dispatch for the reason above: nothing settled means nothing to carry.
              const settled = await this.deps.runStore.get(c.id);
              if (settled?.result) {
                seed.push(settled.result);
                seedRunIds.push(c.id);
              }
            }
          }
        }
        // Only seed cases that are still in the selection (dataset edits between runs shrink, never corrupt).
        const selected = new Set(dataset.cases.map((c) => c.id));
        const keep = seed.map((r, i) => [r, seedRunIds[i]] as const).filter(([r]) => selected.has(r.caseId));
        seed = keep.map(([r]) => r);
        seedRunIds.length = 0;
        seedRunIds.push(...keep.map(([, rid]) => rid).filter((x): x is string => x !== undefined));
      }
    } catch {
      return false; // dataset/subset no longer resolves — not faithfully resumable
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
        if (err instanceof ConflictError) return false;
        throw err;
      }
      harnessSpec = plan.pinSpec(resolvedSpec);
    }
    const remaining = dataset.cases.length - seed.length;
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
        ...(plan.sealedJudges ? { sealedJudges: plan.sealedJudges } : {}),
        ...(plan.modelPins ? { modelPins: plan.modelPins } : {}),
        ...(orch.traceSink ? { sinkOverride: orch.traceSink } : {}),
        ...(orch.oomAutoBoost ? { oomAutoBoost: true } : {}),
        ...(authority ? { authority } : {}),
        resumeNote: `Resumed after a control-plane restart — ${seed.length} finished case(s) kept, ${remaining} re-dispatched${adopted > 0 ? ` (${adopted} in-flight job(s) adopted without re-running)` : ""}`,
      },
    );
    return true;
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
      doneIds: Set<string>;
      // Cases currently executing in THIS process — a synchronous claim so a same-worker Temporal retry of an
      // in-flight case skips instead of double-executing (gap 12). Empty on a fresh ctx (a dead worker → cross-process
      // retry re-executes, so recovery is unaffected).
      inFlightIds: Set<string>;
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
        ? await this.shardHistory(rec.tenant, rec.harness.id, rec.harness.version, targets)
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
    const doneIds = new Set<string>();
    if (this.deps.runStore) {
      const children = await this.deps.runStore.list(rec.tenant, { scorecardId: id });
      // …and the same rule decides what a rebuilt context already considers done (review 39, Phase 4): a
      // case is done when a receipt says which attempt answered it, never when a row happens to be newest.
      // No `.catch(() => [])` — an unreadable ledger fails the context build (retried), it does not read as
      // "nothing is done" (review 40 P0).
      const committedReceipts = (await this.deps.caseReceipts?.list(id)) ?? [];
      const canonical = ScorecardBatch.canonicalChildPerCase(children, committedReceipts);
      for (const c of canonical.values()) if (c.status === "succeeded" && c.result) doneIds.add(c.caseId);
    }
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
                const reattempt = this.reattemptOf({
                  tenant: rec.tenant,
                  scorecardId: id,
                  driverEpoch: rec.ownerEpoch ?? 0,
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
              onLoser: (outcome, cid: string) => this.meterLostAttempt(rec.tenant, outcome.result, cid, id),
              ...(this.deps.cancelQueued
                ? {
                    cancelQueued: (cid: string) =>
                      void this.deps.cancelQueued?.((j) => j.batchId === id && j.evalCase.id === cid),
                  }
                : {}),
            }),
          }
        : {}),
      doneIds,
      // The parent's token as this driver reads it when it takes the batch up. The Temporal path rebuilds
      // this context after a restart, which is exactly when it must be re-read: the worker that rebuilds it
      // IS the current driver, and a worker holding an older context has already lost its activities.
      driverEpoch: rec.ownerEpoch ?? 0,
      inFlightIds: new Set<string>(),
      stepChain: Promise.resolve(),
    };
    this.batchContexts.set(id, ctx);
    return ctx;
  }

  // Serialized progress-step append (read-modify-write on record.steps is racy across concurrent case calls).
  private appendBatchStep(id: string, step: Omit<ScorecardStep, "ts">): Promise<void> {
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
  async planBatch(id: string): Promise<{ caseIds: string[]; concurrency: number }> {
    const ctx = await this.buildBatchContext(id);
    const remaining = [...ctx.caseIndex.keys()].filter((cid) => !ctx.doneIds.has(cid));
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
      message: `Running ${remaining.length} case(s) via Temporal workflow${ctx.doneIds.size > 0 ? ` (${ctx.doneIds.size} finished case(s) kept)` : ""}`,
    });
    return { caseIds: remaining, concurrency: ctx.concurrency };
  }

  // ── A NEW PHYSICAL EXECUTION OPENS ITS OWN ATTEMPT (review 40 follow-up) ───────────────────────────
  //
  // Spillover, the OOM boost and the speculation duplicate all re-dispatch the SAME job, and all of them
  // used to ride the recording generation the first dispatch opened — so `attemptIdOf(executionId, gen)`
  // named a physical attempt only when nothing interesting happened. Two executions of one case (the
  // straggler AND its duplicate, racing concurrently) wrote into one evidence buffer, and the winner's
  // replay could carry the loser's frames. Every internal re-dispatch now opens its own generation; the
  // WINNER's job (SpilloverOutcome.job) is what the finalizer seals, claims and references. An open that
  // fails STRIPS the stale number instead of inheriting it — writing into another physical execution's
  // buffer is the one thing this exists to prevent, so those producers land in the unclaimed g0 bucket.
  // `cx` is the DRIVER's coordinate, not the job's: CaseJob.tenant is optional and the ledger's tenant is not
  // a value to default — every caller of this already holds the batch's own.
  private reattemptOf(cx: {
    tenant: string;
    scorecardId: string;
    driverEpoch?: number;
  }): ((job: CaseJob) => Promise<CaseJob>) | undefined {
    const store = this.deps.recordingStore;
    if (!store) return undefined;
    return async (job: CaseJob): Promise<CaseJob> => {
      const executionId = job.runId;
      if (!executionId) return job;
      // …and each of these re-dispatches is a PHYSICAL EXECUTION with its own ledger row (arch-review 42).
      // These are precisely the attempts that used to leave no trace: a spillover duplicate or a speculation
      // loser spends full compute and, unless it happened to record something, was invisible afterwards.
      const opened = await openPhysicalAttempt(
        { attempts: this.deps.attempts, recordings: store },
        {
          executionId,
          tenant: cx.tenant,
          scorecardId: cx.scorecardId,
          caseId: job.evalCase.id,
          ...(job.trial !== undefined ? { trial: job.trial } : {}),
          ...(cx.driverEpoch !== undefined ? { driverEpoch: cx.driverEpoch } : {}),
        },
      );
      if (opened.generation === undefined) {
        const { recordingGeneration: _stale, ...rest } = job;
        return rest;
      }
      return { ...job, recordingGeneration: opened.generation };
    };
  }

  // runBatchCase — execute + settle exactly one case (idempotent). Mirrors the in-process track dispatch closure:
  // budget admit → child run → secret resolve → executeCase (CP-side transient retry by failure class) → settle →
  // per-case judges → progress step. Kept deliberately parallel to track() — the two drivers share every primitive
  // (executeCase, classifyFailure, applyJudges, billing), only the loop ownership differs.
  // Run ONE case through the full resilience machinery — spillover across the shard list (the shared breaker skips
  // known-outage runtimes) + in-batch OOM auto-boost + tail speculation — returning the result and the runtime that
  // ACTUALLY ran it. Shared by BOTH batch drivers: the in-process `track` loop and the Temporal per-case activity
  // `runBatchCase`, which previously mirrored this ~40-line block "by construction". The site-specific concerns (how a
  // step is appended, whether a child run flips to running) are injected callbacks; the common orchestration events
  // (spillover / oom_escalated) fire here so both drivers report them identically.
  private runResilientCase(
    job: CaseJob,
    cfg: {
      owner: string; // executeCase requires it (private-repo token resolution); both drivers have a defined owner
      targets: string[];
      tenant: string;
      secretMap?: HarnessSecretMaps;
      boostMb?: number;
      oomAutoBoost?: boolean;
      speculation?: SpeculationController;
      onWaiting: (reason: string) => void;
      onStarted?: () => void;
      onStep: (message: string, caseId: string) => void;
      // Opens a fresh recording attempt for a NEW physical execution (spill / OOM boost / speculation
      // duplicate) and returns the job stamped with it — see SpilloverOpts.reattempt.
      reattempt?: (job: CaseJob) => Promise<CaseJob>;
    },
  ): Promise<{ result: CaseResult; target?: string; job: CaseJob }> {
    // Resolve env secret references just before dispatch; a missing referenced secret throws → the case is isolated.
    const resolved =
      cfg.secretMap && job.harnessSpec
        ? { ...job, harnessSpec: resolveHarnessSecrets(job.harnessSpec, cfg.secretMap) }
        : job;
    // OOM escalation — a boosted retry re-runs a memory-killed case with the higher memoryMb on the job only.
    const jobToRun =
      cfg.boostMb !== undefined && resolved.harnessSpec?.kind === "command"
        ? {
            ...resolved,
            harnessSpec: {
              ...resolved.harnessSpec,
              resources: { ...resolved.harnessSpec.resources, memoryMb: cfg.boostMb },
            },
          }
        : resolved;
    // The recording attempt a self-hosted RE-LEASE actually ran under (arch-review 41 P0-evidence): the hub
    // mints a fresh generation at the second lease and reports it via onAttempt — the job the control plane
    // dispatched still carries the first one. Keyed BY THE DISPATCHED JOB, not a shared slot: speculation
    // runs two branches concurrently, and a shared capture would attribute the last lease to whichever
    // branch happened to win.
    const attemptByJob = new Map<CaseJob, number>();
    // Spillover wraps executeCase; tail speculation wraps that (a straggler gets a duplicate, first result wins).
    const exec = (j: CaseJob): Promise<{ result: CaseResult; target?: string; job: CaseJob }> =>
      executeWithSpillover(
        (jj) =>
          executeCase(this.deps, cfg.owner, jj, {
            onWaiting: cfg.onWaiting,
            ...(cfg.onStarted ? { onStarted: cfg.onStarted } : {}),
            onAttempt: (generation) => attemptByJob.set(jj, generation),
          }),
        j,
        {
          targets: cfg.targets,
          tenant: cfg.tenant,
          breaker: this.breaker,
          onSpill: (caseId, from, to, code) => {
            this.deps.onOrchestrationEvent?.({ kind: "spillover", from, to, code });
            cfg.onStep(`${caseId}: runtime spillover ${from} → ${to} (${code})`, caseId);
          },
          ...(cfg.reattempt ? { reattempt: cfg.reattempt } : {}),
        },
      );
    return executeWithOomBoost((j) => (cfg.speculation ? cfg.speculation.run(exec, j) : exec(j)), jobToRun, {
      enabled: cfg.oomAutoBoost ?? false,
      onBoost: (cid, fromMb, toMb) => {
        this.deps.onOrchestrationEvent?.({ kind: "oom_escalated", memoryMb: toMb });
        cfg.onStep(`${cid}: OOM auto-boost ${fromMb} → ${toMb}Mb (in-batch retry)`, cid);
      },
      ...(cfg.reattempt ? { reattempt: cfg.reattempt } : {}),
    }).then((outcome) => {
      // Restamp the WINNER's job with the generation its own dispatch was leased under. Identity-keyed:
      // never another branch's number. (A single recorded attempt with an unmatched winner reference means
      // a wrapper rebuilt the job object on the way back — unambiguous, so it still attributes.)
      const leased =
        attemptByJob.get(outcome.job) ?? (attemptByJob.size === 1 ? [...attemptByJob.values()][0] : undefined);
      return leased === undefined ? outcome : { ...outcome, job: { ...outcome.job, recordingGeneration: leased } };
    });
  }

  async runBatchCase(id: string, caseId: string): Promise<{ settled: boolean; skipped?: boolean }> {
    const ctx = this.batchContexts.get(id) ?? (await this.buildBatchContext(id));
    // Aborted mid-flight (a newer fire superseded this batch, or the user cancelled it) — don't spend more
    // compute/LLM on it. The workflow is cancelled cooperatively; this guard covers activities already in the
    // queue, and it keys on TERMINAL (not just superseded): a user-cancelled batch's queued activities would
    // otherwise run whole cases — and mint fresh queued child runs — for a batch that is already dead.
    const current = await this.deps.store.get(id);
    if (current && ScorecardBatch.from(current).isTerminal()) return { settled: true, skipped: true };
    if (ctx.doneIds.has(caseId)) return { settled: true, skipped: true };
    // Concurrent-dispatch guard (gap 12): a Temporal retry can re-invoke runBatchCase for the SAME caseId (same worker)
    // while the original is still in-flight — before doneIds is set — so both used to execute the harness (wasted
    // compute; the durable result was already at-most-once via doneIds/planBatch). Claim the caseId SYNCHRONOUSLY here
    // so the second invocation skips; release in `finally` so a failed/incomplete attempt is retryable. A cross-process
    // retry (a dead worker → ctx rebuilt) has an empty claim set, so genuine recovery is unaffected.
    if (ctx.inFlightIds.has(caseId)) return { settled: true, skipped: true };
    ctx.inFlightIds.add(caseId);
    try {
      const evalCase = ctx.caseIndex.get(caseId);
      if (!evalCase) throw new NotFoundError("NOT_FOUND", { scorecard: id, caseId }, "case not in this batch.");

      this.deps.budget?.admit(ctx.tenant);
      const runStore = this.deps.runStore;
      const caseEnvelope = current ? await this.childEnvelope(current) : undefined; // §5.2 — the delegated pool this case draws from
      let child: RunRecord | undefined;
      if (runStore) {
        child = newScorecardChildRun({
          id: this.newId(),
          tenant: ctx.tenant,
          harness: { id: ctx.harnessId, version: ctx.harnessVersion },
          caseId,
          parentScorecardId: id,
          executionId: `evd-${id}-${caseId}`, // Temporal parity — one attempt per case, no trial fan-out here
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
      const executionId = `evd-${id}-${caseId}`;
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
        runId: executionId, // trace correlation (Temporal path parity — no trial fan-out here)
        ...(generation !== undefined ? { recordingGeneration: generation } : {}),
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
          const reattempt = this.reattemptOf({ tenant: ctx.tenant, scorecardId: id, driverEpoch: ctx.driverEpoch });
          const outcome = await this.runResilientCase(currentJob, {
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
            // COMPUTE ACTUALLY STARTED — the child flips queued→running, and the attempt ledger records that
            // this execution reached the machine rather than only having been intended (arch-review 42).
            onStarted: () => {
              void this.stampAttempt(attemptId, "executing");
              if (childId && runStore) void this.markChildRunning(childId);
            },
            onStep: (message, cid) =>
              void this.appendBatchStep(id, { phase: "case", status: "info", message, caseId: cid }),
          });
          result = outcome.result;
          ranOn = outcome.target;
          winnerJob = outcome.job;
          break;
        } catch (err) {
          const failure = classifyFailure(err, "dispatch");
          if (attempt >= ctx.retries || !failure.retryable) {
            const message = err instanceof Error ? err.message : String(err);
            result = {
              caseId,
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
            (await this.reattemptOf({ tenant: ctx.tenant, scorecardId: id, driverEpoch: ctx.driverEpoch })?.(
              currentJob,
            )) ?? currentJob;
        }
      }
      // Which attempt the case's answer belongs to: the winner's (a spill/boost/duplicate opened its own);
      // a synthesized failure belongs to the LAST attempt dispatched. Absent = no attempt was isolatable.
      const winnerGeneration = (winnerJob ?? currentJob).recordingGeneration;
      const winnerUnisolated = this.deps.recordingStore !== undefined && winnerGeneration === undefined;
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
      if (!(await this.holdsBatch(id, ctx.driverEpoch))) return { settled: false };
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
            ...(winnerGeneration !== undefined ? { attemptId: attemptIdOf(executionId, winnerGeneration) } : {}),
            // Names the row on the browse page: an eval is known by the case it evaluated.
            ...runEvidenceIdentity(child),
            // The producer's declared clock anchor (a topology case: drive start) — what lets an inline
            // trace with only relative `t` land on the placement plane's wall-clock axis.
            ...(result.traceT0 !== undefined ? { t0: result.traceT0 } : {}),
          }).catch(() => {});
      // Per-case judge scoring — the same "judge the moment the case lands" semantics as the in-process judge stream.
      // The child run id rides along so the judge's own execution seals as a judge:<id> plane on it (the case's
      // execution plane sealed just above, so the judge plane joins an already-named trajectory).
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
            () => this.holdsBatch(id, ctx.driverEpoch),
          )
          .catch(() => {});
      }
      // ── ONE FINALIZER, BOTH DRIVERS (review 39, Phase 2) ─────────────────────────────────────────────
      //
      // Judge coverage, the receipt claim, the evidence assembly and the child's one terminal write are no
      // longer this path's own code. They were, and every review since has found the same defect in whichever
      // copy was edited second — which is why the duplication, not the individual bugs, was the finding.
      const outcome = await this.finalizeCaseAttempt({
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
        ...(unisolated || winnerUnisolated ? { unisolated: true } : {}),
        ...(ranOn ? { ranOn } : {}),
      });
      // A CHILD COMMIT THAT DID NOT HAPPEN IS NOT A SETTLED CASE (review 39 P0-3). `lost` means another
      // attempt owns the case (or this driver was displaced); `unwritten` means the store refused it. Either
      // way this activity did not settle it, and saying otherwise let a case with no result on the ledger
      // pass the finalizer's missing-case check.
      if (outcome.kind !== "committed") return { settled: false };
      result = outcome.result; // what the child carries is what this activity counts
      ctx.doneIds.add(caseId);
      const v = caseVerdict(result, ctx.verdictPolicy);
      const reason = caseReason(result);
      const verdict = v == null ? "no result" : v ? "PASS" : "FAIL";
      await this.appendBatchStep(id, {
        phase: "case",
        status: v === false ? "failed" : "ok",
        message: `${caseId} → ${verdict}${reason ? ` · ${reason}` : ""}`,
        caseId,
      });
      // The lifecycle FACT rode the commit transaction itself (finalizeCaseAttempt, E0) — persisted with the
      // child's terminal write and pushed to the live bus there, so nothing is emitted here.
      return { settled: true };
    } finally {
      ctx.inFlightIds.delete(caseId); // release the claim so a failed/incomplete attempt (or the next case) is unblocked
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
      .sort((a, b) => (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0));
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
    const missing = [...ctx.caseIndex.keys()].filter((cid) => !latest.get(childKey(cid))?.result);
    if (missing.length > 0)
      throw new InternalError(
        "UPSTREAM_ERROR",
        { scorecard: id, missing: missing.slice(0, 20), count: missing.length },
        `${missing.length} case(s) have no result on the ledger — the batch cannot be summarized over the ones that do`,
      );
    // …AND THE RECEIPT SET IS EXACTLY THE PLAN'S (arch-review 41 P1). The check above notices a planned case
    // the ledger cannot answer; this one notices the inverse — a receipt the plan never asked for (a stray
    // seed, a case from a superseded plan) — and it compares on the (caseId, trial) axis, which the id-only
    // check drops. The Temporal driver is single-trial by construction (trialled batches are routed to the
    // in-process loop), so the plan's pairs are (caseId, 0).
    const expectedSet = [...ctx.caseIndex.keys()].map((cid) => ({ caseId: cid, trial: 0 }));
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
    await this.checkReceiptParity(id, results);
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
    const analysis = await offloadAnalysis(this.deps, id, initialBundle, initialPassId(initialBundle));
    // Trace-sink export (batched at finalize on the Temporal path — per-case export streaming stays in-process-only).
    const exported = this.deps.exportResults
      ? await this.deps
          .exportResults(
            ctx.tenant,
            {
              scorecardId: id,
              dataset: `${rec.dataset.id}@${rec.dataset.version}`,
              harness: scorecard.harness,
              // Judge attribution (judge id → declared model) — best-effort, never a reason for the export to fail.
              judgeModels: await this.scoring.collectJudgeModelMap(ctx.tenant, ctx.judges).catch(() => ({})),
              ...(ctx.traceSink ? { sinkOverride: ctx.traceSink } : {}),
            },
            results,
          )
          .catch(() => undefined)
      : undefined;
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
        ...(exported ? { export: exported } : {}),
        ...(analysis.ref ? { analysisRef: analysis.ref } : {}),
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
      { over: "open", epoch: ctx.driverEpoch, expectReceiptCount: decision.receiptCount },
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

  // Retry-failed — a NEW scorecard that re-runs only the failed cases of a terminal batch and carries the passing
  // results over verbatim (full, directly comparable case set; origin.retryOf keeps the lineage). The source record
  // is never mutated — eval history stays immutable. docs/architecture/batch-resilience.md
  async retryFailed(input: {
    tenant: string;
    id: string;
    submittedBy?: string;
    // Failure-class filter — re-run only the cases that died in that class (e.g. "infra" after a cluster incident:
    // agent FAILs are legitimate results and stay carried over). Unset = every non-passing case (previous behavior).
    failureClass?: "infra" | "config" | "harness" | "agent";
  }): Promise<ScorecardRecord> {
    const src = await this.getRecord(input.id); // hydrated (results from child runs when stored as references)
    if (!src || src.tenant !== input.tenant)
      throw new NotFoundError("NOT_FOUND", { scorecard: input.id }, "scorecard not found.");
    // Terminal-only + multi-trial gates — the domain throws the exact 400s this route has always returned.
    ScorecardBatch.from(src).assertCanRetryFailed();
    const results = src.scorecard?.results ?? [];
    if (results.length === 0)
      throw new BadRequestError("BAD_REQUEST", { scorecard: input.id }, "This batch has no per-case results to retry.");
    // Class selection stands on the case OUTCOME, not the bare verdict boolean. "agent" is the product-blame
    // label — it applies ONLY to a completed FAIL (the agent's own outcome). An UNMEASURED case (its judge
    // died leaving unmeasured scores and no case failure) has no verdict and therefore no blame class: the
    // old `verdict !== true → "agent"` fallback swept the platform's dead judges into ?failureClass=agent.
    // A collect-stage failure is retryable even when the ground-truth verdict PASSED — the case is incomplete
    // (trace missing, observation/judge scores never ran), and its retry is a re-collect, not a re-run.
    // Which cases "failed" is a verdict question, so it is answered under the SOURCE batch's stamped policy.
    // A stamp whose document cannot be restored refuses rather than falling back to today's ladder: a retry
    // selected by re-judging history would re-run the cases a rule change invented and carry over the ones it
    // absolved, all under the original's name.
    const resolution = resolvePolicyResolution(src.verdictPolicy, ExecutionPlan.of(src).verdictPolicy);
    if (resolution.status === "unresolvable")
      throw new BadRequestError(
        "BAD_REQUEST",
        { scorecard: input.id, verdictPolicy: src.verdictPolicy },
        "This batch's stamped verdict policy could not be restored, so its failed cases cannot be identified — re-run the batch instead of retrying it.",
      );
    const policy = resolution.policy;
    const incomplete = (r: CaseResult): boolean => r.failure?.stage === "collect";
    const classOf = (r: CaseResult): string | undefined => {
      const outcome = caseOutcome(r, policy);
      if (outcome.status === "completed")
        return outcome.verdict && !incomplete(r) ? undefined : (r.failure?.class ?? "agent");
      if (outcome.status === "infra_failed" || outcome.status === "cancelled") return outcome.failure.class;
      // unmeasured: executed, nothing pass-deciding measured — a scoring outage, never the agent's fault.
      // A collect-starved case keeps its classified class; a plain judge death carries none.
      return r.failure?.class;
    };
    const failed = results.filter((r) =>
      input.failureClass ? classOf(r) === input.failureClass : caseVerdict(r, policy) !== true || incomplete(r),
    );
    if (failed.length === 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { scorecard: input.id, ...(input.failureClass ? { failureClass: input.failureClass } : {}) },
        input.failureClass
          ? `Nothing to retry — no ${input.failureClass}-class failures in this batch.`
          : "Nothing to retry — every case passed.",
      );
    // Stage-aware split: collect-stage failures with a traceRef re-COLLECT (control-plane pull by the frozen
    // correlation coordinates, then judge) — the agent already ran and its output is preserved, so re-dispatching
    // would burn compute to reproduce what we have. Everything else re-dispatches as before.
    const recollect = failed.filter((r) => incomplete(r) && r.traceRef !== undefined);
    const recollectIds = new Set(recollect.map((r) => r.caseId));
    const redispatch = failed.filter((r) => !recollectIds.has(r.caseId));
    const retryIds = new Set(redispatch.map((r) => r.caseId));
    const seed = results.filter((r) => !retryIds.has(r.caseId) && !recollectIds.has(r.caseId));

    // The SOURCE batch's plan — a retry re-runs that experiment, so every sealed facet it carries is the
    // source's, asked once (arch-review 21).
    const sourcePlan = ExecutionPlan.of(src);
    const resolved = await this.deps.datasets.get(input.tenant, src.dataset.id, src.dataset.version);
    const { cases } = selectSubsetCases(
      resolved,
      src.subset ? { ids: src.subset.ids, tags: src.subset.tags, limit: src.subset.limit } : undefined,
    );
    // Re-apply the recorded grading plan — a retry must score exactly like the original submit.
    const dataset: Dataset = { ...resolved, cases: applyGradingPlan(cases, src.orchestration?.graders) };

    let harnessSpec: HarnessSpec | undefined;
    const pins = src.origin?.pinOverrides;
    if (this.deps.harnesses) {
      const harnesses = this.deps.harnesses;
      // Registered → embed the resolved spec; unregistered/built-in (NotFound) → no spec embedded (as at submit); a
      // registered-but-invalid spec fails the retry with a clear 400 rather than re-dispatching a malformed job.
      // The retry re-runs the SOURCE batch's experiment — its manifest closure pins the re-resolved spec's
      // moving bindings, so a moved `latest` model cannot silently change what the retry executes (I6).
      harnessSpec = sourcePlan.pinSpec(
        await embedHarnessSpec(
          () =>
            pins && Object.keys(pins).length > 0
              ? harnesses.resolveWithPins(input.tenant, src.harness.id, src.harness.version, pins)
              : harnesses.get(input.tenant, src.harness.id, src.harness.version),
          { id: src.harness.id, version: src.harness.version },
        ),
      );
    }

    // OOM auto-escalation: a case killed for memory dies the same way on an as-is retry, so its re-dispatch runs
    // with resources.memoryMb DOUBLED. The base is the previous retry's boost (origin.memoryBoostMb) when there
    // was one, so repeated retries compound (64 → 128 → 256 …) up to the cap; the registry spec is never mutated
    // (the boost rides the job only) and non-OOM cases keep the declared resources.
    const specBaseMb = harnessSpec?.kind === "command" ? (harnessSpec.resources?.memoryMb ?? 1024) : 1024;
    const memoryBoostMb: Record<string, number> = {};
    for (const r of redispatch) {
      if (r.failure?.code !== OOM_KILLED) continue;
      const base = src.origin?.memoryBoostMb?.[r.caseId] ?? specBaseMb;
      memoryBoostMb[r.caseId] = Math.min(OOM_ESCALATION_CAP_MB, base * 2);
      this.deps.onOrchestrationEvent?.({ kind: "oom_escalated", memoryMb: memoryBoostMb[r.caseId] as number });
    }
    const boosted = Object.keys(memoryBoostMb).length;
    // Inherit lineage fields but never the previous boost map — the new record carries only ITS boosts.
    const { memoryBoostMb: _previousBoost, ...inheritedOrigin } = (src.origin ?? {}) as Partial<ScorecardOrigin>;

    // Pre-orchestration source records still retry — with no judges/judge on file, re-run cases get grader scores only.
    const orch = src.orchestration ?? { judges: [], concurrency: this.concurrency, retries: 1 };
    const record: ScorecardRecord = ScorecardBatch.newQueued({
      id: this.newId(),
      tenant: input.tenant,
      dataset: { id: dataset.id, version: dataset.version },
      harness: src.harness,
      // The boost map is REPLACED per retry (not inherited) — it records what THIS retry ran with; recovered
      // cases drop out, still-OOM cases re-enter with the compounded value.
      origin: {
        source: "api",
        ...inheritedOrigin,
        retryOf: src.id,
        ...(boosted > 0 ? { memoryBoostMb } : {}),
      },
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      ...(src.runtime ? { runtime: src.runtime } : {}),
      ...(src.subset ? { subset: src.subset } : {}),
      // …AND THE SOURCE'S SEALED IDENTITY. A retry re-runs THAT experiment — same dataset documents, same
      // harness closure, same judges; that is what `retryOf` means and what the dispatch below already pins
      // its models from. The record was inheriting the lineage and not the identity, so the new batch could
      // not state what it was: its own resume, its own Temporal plan and every later comparison read an
      // unsealed record. Sealing a SECOND time would be worse than not sealing — it would re-resolve today's
      // registry and quietly turn a retry into a different experiment.
      ...(src.manifest ? { manifest: src.manifest } : {}),
      orchestration: orch,
      now: this.now(),
    });
    await this.deps.store.create(record);
    void (async () => {
      // Stage-aware recovery BEFORE the dispatch loop: re-pull each collect-failed case by its traceRef and
      // judge the ones that recovered — zero agent re-runs. Still-unrecovered cases carry their {collect}
      // classification into the new batch verbatim (fix the platform, retry again).
      const recovered: CaseResult[] = [];
      let healed = 0;
      for (const r of recollect) {
        const evalCase = dataset.cases.find((c) => c.id === r.caseId);
        if (!evalCase) {
          recovered.push(r); // case left the dataset — carry as-is rather than dropping the result
          continue;
        }
        const attempt = await collectDeferredTrace(this.deps, input.tenant, evalCase, r).catch(() => r);
        if (attempt.failure === undefined) {
          healed += 1;
          if (orch.judges.length > 0)
            await this.scoring
              .applyJudges(
                input.tenant,
                dataset,
                [attempt],
                orch.judges,
                src.runtime,
                input.submittedBy,
                undefined,
                sourcePlan.sealedJudges,
              )
              .catch(() => {});
        }
        recovered.push(attempt);
      }
      const recollectNote =
        recollect.length > 0
          ? `, ${recollect.length} collect-failed case(s) re-collected without re-run (${healed} recovered)`
          : "";
      const boostNote =
        boosted > 0 ? `, ${boosted} OOM case(s) escalated to ${Object.values(memoryBoostMb).join("/")}Mb` : "";
      const resumeNote = `Retry of ${src.id} — re-running ${redispatch.length} failed case(s), ${seed.length} passing result(s) carried over${recollectNote}${boostNote}`;

      // ── A CARRIED RESULT IS AN INHERITED OUTCOME, COMMITTED LIKE ANY OTHER (arch-review 41 P0) ──────
      //
      // Materialized for BOTH drivers, before the driver fork: the Temporal plan skips a receipted case, the
      // in-process ledger gate holds every counted case to a receipt, and a CP crash mid-retry recovers the
      // carried passes from the ledger instead of losing them (they used to live only in this process's
      // memory on the in-process path — a resume then re-ran the very cases the retry had declared already
      // answered). Child + receipt go through the SAME atomic commit point as an executed case: as two
      // writes, a crash between them left a terminal child with no receipt, which recovery reads as
      // "uncommitted → re-execute".
      const carriedIn = [...seed, ...recovered];
      const seededRunIds: string[] = [];
      if (this.deps.runStore && this.deps.caseReceipts) {
        const runStore = this.deps.runStore;
        const receipts = this.deps.caseReceipts;
        // Seeds carry the envelope stamp for lineage consistency but never settle against it — their cost
        // was already settled by the batch that originally ran them. Resolved once, not per seed.
        const seededEnvelope = await this.childEnvelope(record);
        for (const r of carriedIn) {
          const seededChild = newSeededScorecardChildRun({
            id: this.newId(),
            tenant: input.tenant,
            harness: src.harness,
            result: r,
            parentScorecardId: record.id,
            ...(src.runtime ? { runtime: src.runtime } : {}),
            origin: ScorecardBatch.childRunOrigin(record),
            ...(seededEnvelope ? { envelope: seededEnvelope } : {}),
            now: this.now(),
          });
          // Through `receiptOf`, so the inherited receipt carries the same judgment identity every other
          // receipt does (the inline literal here carried no judgeClosureDigest — an asymmetry, not a choice).
          const outcome = await receipts.commitCase(
            this.receiptOf(record.id, r, {
              childId: seededChild.id,
              kind: "inherited",
              sourceScorecardId: src.id,
              judges: orch.judges,
              ...(sourcePlan.sealedJudges ? { sealedJudges: sourcePlan.sealedJudges } : {}),
            }),
            async (runs) => {
              await runs.create(seededChild);
              return seededChild;
            },
            runStore,
          );
          // An idempotent re-seed (already_committed) keeps the FIRST child — the receipt names it.
          seededRunIds.push(outcome.kind === "already_committed" ? outcome.receipt.childRunId : seededChild.id);
        }
      }
      // Temporal parity: when the batch driver is configured, the retry batch is workflow-owned too — a CP
      // restart mid-retry must not lose it. The materialized seeds above mean the idempotent planBatch
      // naturally skips them and finalize aggregates them; the workflow then drives only the re-dispatch
      // remainder. Start failure degrades to the in-process loop (same as submit).
      // …and a TRIALLED source degrades to the in-process loop, exactly like submit (review 40 follow-up):
      // the Temporal finalize's missing-case gate iterates case ids (the workflow drives per-case, no trial
      // fan-out), so a workflow-owned trialled retry would under-enforce the very accounting it exists for.
      if (this.deps.temporalBatches && this.deps.runStore && !ScorecardBatch.from(src).isMultiTrial()) {
        const workflowId = this.deps.temporalBatches.workflowIdFor(record.id);
        await this.deps.store.update(record.id, {
          orchestration: { ...orch, workflowId },
          steps: [{ ts: this.now(), phase: "resume", status: "info", message: resumeNote }],
          updatedAt: this.now(),
        });
        try {
          await this.deps.temporalBatches.start(record.id);
          return;
        } catch {
          // Strip the workflow claim and fall through to the in-process loop (same degradation as submit).
          await this.deps.store.update(record.id, { orchestration: orch, updatedAt: this.now() });
        }
      }
      await this.track(
        record.id,
        input.tenant,
        input.submittedBy ?? input.tenant,
        dataset,
        src.harness.id,
        src.harness.version,
        harnessSpec,
        orch.judges,
        src.runtime,
        orch.judge,
        orch.concurrency,
        {
          seed: carriedIn,
          ...(seededRunIds.length > 0 ? { seedRunIds: seededRunIds } : {}),
          retries: orch.retries,
          ...(sourcePlan.sealedJudges ? { sealedJudges: sourcePlan.sealedJudges } : {}),
          ...(sourcePlan.modelPins ? { modelPins: sourcePlan.modelPins } : {}),
          ...(boosted > 0 ? { memoryBoostMb } : {}),
          ...(orch.traceSink ? { sinkOverride: orch.traceSink } : {}),
          resumeNote,
        },
      );
    })();
    return record;
  }

  // Flip a fan-out child run queued→running when its case actually begins executing (the onStarted hook fires on
  // managed dispatch / self-hosted lease). Best-effort and idempotent: acts only on a still-queued child (a re-fire
  // from spillover/speculation, or a race with settlement, is a no-op), and a store error never disturbs the run.
  // First terminal write wins: a child settled by cancel (failed{CANCELLED} via stopInFlight) must not be
  // resurrected or rewritten by a late-landing drain — the killed dispatch's rejection, or a case that was
  // already past the point of no return when the user stopped the batch. The transition is built from the
  // CURRENT record (never the creation-time snapshot) so the domain's terminal guard sees the truth.
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
    if (await this.holdsBatch(id, fenced.expectOwnerEpoch)) return true;
    controller.abort(); // stop the sibling lanes too — they are dispatching under the same lost authority
    return false;
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

  // The child's ONE terminal write, carrying the result as it now stands — execution plus whatever the judges
  // attached to it (a failed judge leaves its `unmeasured` row, which is evidence too). Idempotent: the entry
  // is consumed, so a second call after a retried stream does nothing.
  //
  // THE PENDING MAP IS THE BATCH'S, NOT THE SERVICE'S (arch-review 34 P0). It was an instance field keyed by
  // `caseId#trial` — no tenant, no scorecard — and one `ScorecardService` drives every batch in the process.
  // Two batches with a case of the same name (`c1`, which is what half the datasets in the world call their
  // first case) overwrote each other's entry: one child settled with the OTHER batch's result, under the
  // OTHER batch's parent fence, and the second settle found nothing pending and never settled at all. Across
  // workspaces, that is one tenant's evidence written onto another tenant's row. The state is per-batch
  // because the thing it describes is: it now lives in the `track` call that owns those cases.
  // Everything a case produces, assembled onto its result before the ONE terminal write that publishes it:
  // the offloaded snapshot and the sealed replay, both under the ATTEMPT that produced them. Shared by the
  // in-process loop and the Temporal driver, because a case's evidence should not depend on which driver a
  // deployment happens to run — that difference is how "terminal means finalized" was true on one path and
  // false on the other for a whole review.
  //
  // Best-effort by contract: a failed offload or an unsealed recording must never cost a case its verdict.
  private async assembleCaseEvidence(
    result: CaseResult,
    // `generation` absent = the attempt never opened one (arch-review 46): the snapshot stays INLINE rather
    // than staged under a fabricated `#g0` key — the execution id is stable across a re-drive by
    // construction, so two unisolated attempts of one case would share one object key with no CAS beneath.
    where: { scorecardId: string; executionId: string; generation?: number; unisolated?: boolean },
  ): Promise<void> {
    if (this.deps.artifacts && where.generation !== undefined) {
      try {
        // Keyed by the ATTEMPT, not by the case (arch-review 37 P0). `scorecards/<id>/<caseId>` gave every
        // trial of a case one object key, so trial 1 overwrote the bytes trial 0's result still points at —
        // an execution id was stamped on the row and then not used for the artifact it names.
        // Keyed by the attempt, GENERATION INCLUDED (arch-review 38 P0). `attempts/<executionId>` is stable
        // across a re-drive by construction — that is what an execution id is for — so a stale attempt's
        // offload overwrote the bytes the winner's result already points at. The generation is the part that
        // differs between two attempts of one case.
        result.snapshot = await offloadSnapshot(
          result.snapshot,
          this.deps.artifacts,
          `attempts/${attemptIdOf(where.executionId, where.generation)}`,
        );
      } catch {}
    }
    // …unless this attempt could not isolate its buffer (see `unisolated`): sealing then would publish an
    // earlier attempt's frames as this result's replay, which is worse than having none.
    if (this.deps.recordingStore && !where.unisolated && where.generation !== undefined) {
      try {
        await foldEnvDeltas(this.deps.recordingStore, where.executionId, result, where.generation);
        const ref = await this.deps.recordingStore.seal(
          where.executionId,
          { envKind: result.snapshot.kind, dispatch: dispatchManifest(result.harness) },
          where.generation,
        );
        if (ref) result.recordingRef = ref;
      } catch {}
    }
  }

  // `committed` — this case's evidence is on the ledger, and everything downstream may derive from it.
  // `lost` — a takeover or a cancel took the case: not ours, and not a failure of anything.
  // `unwritten` — we could not write it. That distinction is the point (arch-review 37 P0): a parent that
  // SUCCEEDS while one of its cases never reached the ledger is a scorecard whose summary counts a result no
  // reader can find, because the aggregate was built from this process's memory and the ledger disagrees.
  private async settleJudgedChild(
    scorecardId: string,
    tenant: string,
    announce: { verdictPolicy?: VerdictPolicy; owner?: string },
    pending: Map<string, PendingChildSettle>,
    finalized: Map<string, FailureFinalization>,
    result: CaseResult,
  ): Promise<"committed" | "lost" | "unwritten"> {
    const key = childKey(result.caseId, result.trial);
    // This loop sent it down the failure exit, and runSuite has now frozen the failure as FINAL — the child
    // is still OPEN (the catch terminalizes nothing, arch-review 41 P0-lifecycle). So the failure commits
    // through the SAME atomic commit point as every other outcome: receipt + fenced terminal fail-write in
    // one transaction, judge coverage stated, evidence assembled, completion fact riding the commit.
    const failure = finalized.get(key);
    if (failure) {
      // A ledger is wired and this exit has no child row to commit (the create itself threw): the case is
      // counted in memory and cannot be accounted on the ledger — `unwritten` is the honest answer (the
      // batch refuses to summarize, recoverable), exactly as the raw failure receipt answered before.
      if (!failure.childId && this.deps.runStore && this.deps.caseReceipts) return "unwritten";
      const outcome = await this.finalizeCaseAttempt({
        scorecardId: failure.parentDriver.scorecardId,
        epoch: failure.parentDriver.epoch,
        result,
        outcome: "failed",
        error: failure.error,
        judges: failure.judges,
        ...(failure.sealedJudges ? { sealedJudges: failure.sealedJudges } : {}),
        tenant,
        announce,
        ...(failure.childId ? { childId: failure.childId } : {}),
        executionId: failure.executionId,
        ...(failure.generation !== undefined ? { generation: failure.generation } : {}),
        ...(failure.unisolated ? { unisolated: true } : {}),
      });
      if (outcome.kind === "committed") result.scores = outcome.result.scores;
      return outcome.kind;
    }
    const entry = pending.get(key);
    if (!entry) return "lost"; // never ours, or a second call for one case
    pending.delete(key);
    // Everything that "ending a case" MEANS lives in one place now (see finalizeCaseAttempt); what is left
    // here is this loop's own bookkeeping — which case, and whether it already ended.
    const outcome = await this.finalizeCaseAttempt({
      scorecardId: entry.parentDriver.scorecardId,
      epoch: entry.parentDriver.epoch,
      result,
      judges: entry.judges,
      ...(entry.sealedJudges ? { sealedJudges: entry.sealedJudges } : {}),
      tenant,
      announce,
      ...(entry.childId ? { childId: entry.childId } : {}),
      executionId: entry.executionId,
      ...(entry.generation !== undefined ? { generation: entry.generation } : {}),
      ...(entry.unisolated ? { unisolated: true } : {}),
      ...(entry.ranOn ? { ranOn: entry.ranOn } : {}),
    });
    // …and the PARENT counts what the child carries. Judge coverage may have added rows, and the aggregate
    // holds this very object — so a summary built from it would otherwise disagree with the ledger about a
    // judge that never answered, which is the disagreement this whole seam exists to prevent.
    if (outcome.kind === "committed") result.scores = outcome.result.scores;
    return outcome.kind;
  }

  // ── THE RECEIPT NAMES WHAT THE CHILD WILL CARRY (review 39 P0 · review 40 P0) ────────────────────────
  //
  // A pure builder: the claim itself is `commitCase` now — one transaction with the child's terminal write.
  // The digest is computed over the result AS IT WILL BE PERSISTED, which is why every caller builds the
  // receipt AFTER `assembleCaseEvidence`: the assembly mutates the result (snapshot refs, recordingRef), and
  // a digest taken before it named bytes no row ever carried — the parity check then reported a divergence
  // on every case with an offloaded snapshot, which is a diagnostic crying wolf.
  //
  // `generation` is optional because one caller genuinely does not know it: a RECOVERY adopting a result
  // from a backend never opened the attempt that produced it. An unknown attempt number is recorded as
  // absent rather than as 0 — 0 is a real generation, and claiming to know is worse than saying nothing.
  private receiptOf(
    scorecardId: string,
    result: CaseResult,
    entry: {
      childId: string;
      // The outcome ledger's discriminant (arch-review 42): executed | failed | inherited. Every producer
      // states it — only pre-discriminant rows read as absent.
      kind: NonNullable<CaseCommitReceipt["kind"]>;
      // Required with kind "inherited": the batch whose execution the carried result actually is.
      sourceScorecardId?: string;
      executionId?: string;
      generation?: number;
      judges: ReadonlyArray<{ id: string }>;
      sealedJudges?: SealedJudgeClosure[];
    },
  ): CaseCommitReceipt {
    return {
      scorecardId,
      caseId: result.caseId,
      trial: result.trial ?? 0,
      childRunId: entry.childId,
      kind: entry.kind,
      ...(entry.sourceScorecardId !== undefined ? { sourceScorecardId: entry.sourceScorecardId } : {}),
      ...(entry.executionId !== undefined ? { executionId: entry.executionId } : {}),
      ...(entry.generation !== undefined ? { generation: entry.generation } : {}),
      // …and the joined identity, so a reader comparing a receipt with a sealed replay or an artifact key
      // compares STRINGS rather than re-deriving the pair and hoping both sides did it the same way.
      ...(entry.executionId !== undefined && entry.generation !== undefined
        ? { attemptId: attemptIdOf(entry.executionId, entry.generation) }
        : {}),
      // Through the ONE spelling (caseResultDigest): the digest must match across the jsonb round-trip —
      // ScoreSchema's read-time normalizer reshapes what a producer literally wrote (see case-result-digest.ts).
      resultDigest: caseResultDigest(result),
      // …and the execution's own digest, invariant under re-judgment (arch-review 41 P1): a later re-score
      // replaces scores in place, so resultDigest diverges from the row — this one is what "still the
      // execution the receipt vouches for" compares from then on.
      observationDigest: caseObservationDigest(result),
      // The judge-closure identity: the SEALED closure when the manifest carries one (each entry pins the
      // judge document and its nested model/rubric/harness digests — the whole judgment, not its name), and
      // only a batch that sealed nothing falls back to the bare id list. Sorted by id so the digest is a
      // set identity, not an ordering accident.
      ...(entry.sealedJudges && entry.sealedJudges.length > 0
        ? { judgeClosureDigest: contentDigest([...entry.sealedJudges].sort((a, b) => (a.id < b.id ? -1 : 1))) }
        : entry.judges.length > 0
          ? { judgeClosureDigest: contentDigest(entry.judges.map((j) => j.id).sort()) }
          : {}),
      committedAt: this.now(),
    };
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
  private meterLostAttempt(tenant: string, result: CaseResult, caseId: string, id: string): void {
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

  // ── THE ONE PLACE A CASE IS FINALIZED (review 39, Phase 2) ───────────────────────────────────────────
  //
  // Both drivers used to hold their own copy of "what ending a case means", and every review since has found
  // the same defect in whichever copy was edited second: the Temporal path settled without assembling, the
  // in-process path claimed without covering its judges, one honoured the settle's answer and the other threw
  // it away. Reviewing them separately is what made the recurrence structural.
  //
  // So the ORDER is stated once, and it is the whole content of the contract:
  //
  //   ① complete the judge coverage — a selected judge that never answered leaves a stated row, not silence
  //   ② assemble the evidence — snapshot offload + recording seal, staged under the attempt's OWN key
  //      (`attempts/<attemptId>`), so a concurrent attempt's staging never overwrites a winner's bytes: a
  //      loser's artifacts become unreferenced orphans, not corruption
  //   ③ COMMIT — the receipt claim and the child's one terminal write, in ONE transaction (review 40 P0).
  //      As two writes, a claim whose child settle was then refused poisoned the case forever: canonical
  //      right acquired, canonical artifact never recorded. Claiming the right to commit is not the commit.
  //
  // ② before ③ is what makes the receipt's digest TRUE: the assembly mutates the result (snapshot refs,
  // recordingRef), and the digest must name the bytes the child row will actually carry.
  //
  // The result is what the caller must persist and count — coverage may have added rows to it — so it is
  // returned rather than mutated in place.
  private async finalizeCaseAttempt(input: {
    scorecardId: string;
    epoch: number;
    result: CaseResult;
    // Which terminal transition this commit applies — the SAME transaction shape either way (arch-review 41
    // P0-lifecycle): receipt claim + fenced terminal write, all-or-nothing. Default "succeeded".
    outcome?: "succeeded" | "failed";
    // The failure as the exit recorded it — required with outcome "failed" (the fail transition names it).
    error?: { code: string; message: string };
    judges: ReadonlyArray<{ id: string }>;
    sealedJudges?: SealedJudgeClosure[];
    childId?: string;
    executionId: string;
    // Absent when the attempt never opened one (fail-closed: nothing seals then — see assembleCaseEvidence).
    generation?: number;
    unisolated?: boolean;
    ranOn?: string;
    // The completion FACT's ingredients (review 40 follow-up, E0): with a ledger, the fact rides the commit
    // transaction itself — persisted if and only if the case committed, so a loser structurally announces
    // nothing; without one, it falls back to the best-effort emit this fact always had.
    tenant?: string;
    announce?: { verdictPolicy?: VerdictPolicy; owner?: string };
  }): Promise<{ kind: "committed"; result: CaseResult } | { kind: "lost" } | { kind: "unwritten" }> {
    const covered =
      input.judges.length > 0
        ? { ...input.result, scores: completeJudgeCoverage(input.result.scores, input.judges) }
        : input.result;
    const completionFact = (): { message: string; fact: DomainFact & { message: string; recipient?: string } } => {
      const v = caseVerdict(covered, input.announce?.verdictPolicy);
      const reason = caseReason(covered);
      const verdict = v == null ? "no result" : v ? "PASS" : "FAIL";
      const message = `Scorecard ${input.scorecardId} case ${covered.caseId} → ${verdict}${reason ? ` · ${reason}` : ""}`;
      return {
        message,
        fact: {
          kind: "scorecard.case.completed",
          subject: { type: "scorecard", id: input.scorecardId },
          payload: {
            caseId: covered.caseId,
            ...(covered.trial !== undefined ? { trial: covered.trial } : {}),
            verdict: v ?? null,
            ...(reason !== undefined ? { reason } : {}),
          },
          message,
          ...(input.announce?.owner !== undefined ? { recipient: input.announce.owner } : {}),
        },
      };
    };
    // A batch with no run store has no child to commit — the case really did finish, and there is nothing for
    // a receipt to make canonical either. The fact keeps its historical best-effort emit here.
    const runStore = this.deps.runStore;
    const childId = input.childId;
    if (!childId || !runStore) {
      // A wired ledger with no child row to commit cannot account for the case — refusing to summarize is
      // the honest answer, never a receipt for a child that does not exist.
      if (runStore && this.deps.caseReceipts) return { kind: "unwritten" };
      if (input.announce && input.tenant !== undefined) {
        const { fact } = completionFact();
        void this.deps.events?.emit({ workspace: input.tenant, ...fact });
      }
      return { kind: "committed", result: covered };
    }
    const stamped =
      input.announce && input.tenant !== undefined
        ? stampFacts(input.tenant, [completionFact().fact], { newId: this.newId, now: this.now })
        : [];
    await this.assembleCaseEvidence(covered, {
      scorecardId: input.scorecardId,
      executionId: input.executionId,
      // An attempt that never opened a generation must not seal generation 0's buffer as its replay —
      // 0 is a real generation; "unknown" is `unisolated`, the same fail-closed answer the dispatch gives.
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
      ...(input.unisolated || input.generation === undefined ? { unisolated: true } : {}),
    });
    // The constructor guard couples the receipt store to the run store, so this branch is unreachable in a
    // wired service — and if a wiring ever uncouples them, refusing the commit is the only honest answer.
    const receipts = this.deps.caseReceipts;
    if (!receipts) return { kind: "unwritten" };
    const failureError = input.error ?? { code: "INTERNAL", message: "case failed" };
    // WHICH PHYSICAL ATTEMPT this commit is made by — the same spelling the receipt records, so the two
    // ledgers can be compared rather than assumed to agree (arch-review 42). Absent when no attempt was
    // minted; there is then no row to stamp, and inventing a coordinate would address somebody else's.
    const attemptId = input.generation === undefined ? undefined : attemptIdOf(input.executionId, input.generation);
    // `failed` is a terminal outcome of a REAL execution, not a supersede: the case ended here, with this
    // attempt's frozen failure as the answer.
    const terminalState: ExecutionAttemptState = input.outcome === "failed" ? "failed" : "committed";
    const outcome = await receipts
      .commitCase(
        this.receiptOf(input.scorecardId, covered, {
          childId,
          kind: input.outcome === "failed" ? "failed" : "executed",
          executionId: input.executionId,
          ...(input.generation !== undefined ? { generation: input.generation } : {}),
          judges: input.judges,
          ...(input.sealedJudges ? { sealedJudges: input.sealedJudges } : {}),
        }),
        async (runs, attempts) => {
          const settled = await this.settleChildOn(
            runs,
            childId,
            (cur) =>
              input.outcome === "failed"
                ? // The failure transition, WITH the frozen failure result — the same bytes the parent counts
                  // and the receipt's digest names (failedCaseResult is pure over (job, err), so runSuite's
                  // copy and this one are identical).
                  Run.from(cur).fail(failureError, this.now(), covered).patch
                : {
                    ...Run.from(cur).succeed(covered, this.now()).patch,
                    // Provenance: the runtime that ACTUALLY ran the case (differs from the assigned one after a spillover).
                    ...(input.ranOn ? { runtime: input.ranOn } : {}),
                  },
            { scorecardId: input.scorecardId, epoch: input.epoch },
            stamped.length > 0 ? stamped.map((f) => f.record) : undefined,
          );
          // ── THE ATTEMPT'S TERMINAL STAMP RIDES THE COMMIT (arch-review 43) ─────────────────────────────
          //
          // Phase 1 stamped this AFTER the commit resolved, best-effort: a crash in that window left a
          // committed receipt beside an attempt row still saying `created` — a receipt naming an execution
          // the physical ledger never saw end. Inside the transaction it is the same decision as the receipt
          // and the child's terminal write, so there is no window to crash in and no `.catch` to hide a
          // ledger that could not record what the receipt claims.
          //
          // AFTER the settle, never before: a refused fence returns here and the stamp must not have said
          // "committed" about an attempt that lost (the in-memory twin has no rollback to undo it with). The
          // transition's own answer is deliberately not read — a refusal is a silent no-op by contract (an
          // idempotent re-commit meeting its own terminal row is the ordinary case), and only a THROW, which
          // is a store fault, aborts the commit.
          //
          // TWO CONDITIONS, and they ask different questions: `this.deps.attempts` is whether this service
          // has a ledger AT ALL (an adapter that can always build a transaction-bound twin would otherwise
          // stamp a plane the deployment was configured without), and `attempts` is the store the write must
          // go through — the transaction's twin wherever one exists.
          if (settled === undefined) return undefined;
          if (this.deps.attempts && attempts && attemptId !== undefined)
            await attempts.transition(attemptId, terminalState, {
              childRunId: childId,
              ...(input.outcome === "failed" ? { error: failureError } : {}),
            });
          return settled;
        },
        runStore,
        this.deps.attempts,
      )
      .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
    if (outcome instanceof Error) return { kind: "unwritten" }; // the store could not take it — the batch must not pass
    if (outcome.kind === "committed") {
      // The fact is already persisted (it rode the commit transaction); this is only the live-bus nudge.
      // An idempotent re-claim (already_committed below) pushes nothing — the first commit already did.
      if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
      // …and the attempt reached its terminal state inside that same transaction (see the settle above).
      return { kind: "committed", result: covered };
    }
    if (outcome.kind === "already_committed") {
      // The idempotent retry (a Temporal activity re-running its own commit) is a success; any OTHER child
      // owning the case means a concurrent attempt won — this one was never the case's answer.
      if (outcome.receipt.childRunId === childId) {
        // Best-effort, and it stays that way: THIS call's transaction never ran (the claim was already
        // there), so there is nothing for the stamp to ride. The winning commit — the first one — stamped
        // this attempt inside its own transaction; a row that pre-dates the promotion is repaired here, a
        // row that does not is refused as already terminal. Either way it is diagnostic, not the decision.
        await this.stampAttempt(attemptId, terminalState, {
          childRunId: childId,
        });
        return { kind: "committed", result: covered };
      }
      // A LOSER'S STAMP CANNOT RIDE A TRANSACTION, because the loser never had one: its claim was refused
      // before any settle ran (`already_committed`), or its transaction rolled back whole (`unsettled`). So
      // the two supersede stamps below stay best-effort — a diagnostic saying which attempts ran and lost.
      // The WINNER's stamp is the one the commit carries, and losing that one is what may never be swallowed.
      await this.stampAttempt(attemptId, "superseded");
      return { kind: "lost" };
    }
    // `unsettled` — the child's fence refused (takeover / cancel / already terminal) and the claim rolled
    // back with it: the case belongs to whoever holds the authority now.
    await this.stampAttempt(attemptId, "superseded");
    return { kind: "lost" };
  }

  private async settleChild(
    childId: string,
    settle: (current: RunRecord) => Partial<RunRecord>,
    parentDriver?: { scorecardId: string; epoch: number },
  ): Promise<RunRecord | undefined> {
    const store = this.deps.runStore;
    if (!store) return undefined;
    return this.settleChildOn(store, childId, settle, parentDriver);
  }

  private async settleChildOn(
    // The store this settle must go through — commitCase hands a TRANSACTION-BOUND twin so the child's
    // terminal write commits or rolls back with the receipt claim (review 40 P0).
    store: RunStore,
    childId: string,
    settle: (current: RunRecord) => Partial<RunRecord>,
    // The batch this child belongs to, and the epoch its driver holds. Proved INSIDE the write: the child's
    // own epoch cannot answer "am I still this batch's driver" (arch-review 33 P0).
    parentDriver?: { scorecardId: string; epoch: number },
    // Outbox facts that ride the SAME write (E0): inside commitCase this is the same transaction as the
    // receipt claim, so "the case completed" is persisted if and only if the case actually committed.
    events?: OutboxEvent[],
  ): Promise<RunRecord | undefined> {
    const current = await store.get(childId);
    if (!current || Run.from(current).isTerminal()) return undefined;
    // …and the CONDITION travels with the write (Tier B, the cancel/completion race). The read above builds
    // the patch and answers "is there anything to do"; it cannot answer "is this row still open", because the
    // other writer is in another process — a user's cancel in the control plane against a case drain landing
    // from a worker. Read-check-write made the LAST write win, which is the exact inverse of the rule this
    // method is named after.
    // …under the child's own epoch AND the parent's driver. The first refuses a child somebody claimed
    // directly; the second refuses a driver that lost the BATCH — two different takeovers, and the child's
    // number moves for only one of them.
    //
    // The ANSWER is returned, because everything a finished case does next — announcing it, exporting it,
    // counting it done — is authority the committed transition owns and the attempt does not (arch-review 35
    // P1). Swallowing it made "the judges are done" the licence, which is one step short of the truth.
    return await settleRun(store, childId, settle(current), events, {
      epoch: current.ownerEpoch ?? 0,
      ...(parentDriver ? { parentDriver } : {}),
    });
  }

  // ── THE PHYSICAL ATTEMPT'S STATE, WHERE NO COMMIT TRANSACTION EXISTS TO RIDE (arch-review 42 · 43) ──
  //
  // The WINNER's terminal stamp no longer comes through here: it rides the case commit itself, inside the
  // transaction that makes the receipt (finalizeCaseAttempt's settle closure), where a throw aborts the
  // commit instead of being swallowed. What is left on this path is every stamp that HAS no transaction to
  // ride — `executing` (no commit is being made), a loser's `superseded` (its transaction never ran or
  // rolled back whole), a retry's abandon stamp (the abandoned attempt commits nothing). Those are
  // diagnostics: they name what ran, and no outcome is derived from them, which is why they may be swallowed.
  //
  // `attemptId` is absent when no attempt was minted (no ledger wired, or an execution that never opened a
  // generation): there is no row to stamp, and inventing a coordinate would address somebody else's.
  private async stampAttempt(
    attemptId: string | undefined,
    to: ExecutionAttemptState,
    patch?: { childRunId?: string; unisolated?: boolean; error?: { code: string; message: string } },
  ): Promise<void> {
    const attempts = this.deps.attempts;
    if (!attempts || attemptId === undefined) return;
    await attempts.transition(attemptId, to, patch).catch(() => {});
  }

  private async markChildRunning(childId: string): Promise<void> {
    const store = this.deps.runStore;
    if (!store) return;
    try {
      const rec = await store.get(childId);
      if (!rec || rec.status !== "queued") return; // already running/terminal — nothing to flip
      await store.update(childId, Run.from(rec).start(this.now()).patch, undefined, { expectNonTerminal: true });
    } catch {
      // Best-effort visibility flip — a failure here must never break the case (the run still executes and settles).
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
    // Re-drive support (docs/architecture/batch-resilience.md):
    //  seed        — finished CaseResults carried in verbatim (restart resume: done children · retry-failed: source passes).
    //                Seeded cases are NOT re-dispatched, re-judged, or re-exported; they merge into the final scorecard.
    //  seedRunIds  — the child-run ids behind the seeds (kept in record.runIds so get() hydration still sees every case).
    //  retries     — transient dispatch retries per case (throw-only).
    //  resumeNote  — a timeline step explaining why this track run starts mid-way.
    //  trials      — run each case N times (pass@k / flakiness); one child run per (case, trial). Default 1.
    opts: {
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
    } = {},
  ): Promise<void> {
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
    const seededIds = new Set(seed.map((r) => r.caseId));
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
    const childEnv = batchForOrigin ? await this.childEnvelope(batchForOrigin) : undefined; // §5.2, once per batch
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
        await this.stampAttempt(
          reopened.generation === undefined ? undefined : attemptIdOf(reopened.executionId, reopened.generation),
          "superseded",
          { error: reopened.error },
        );
      }
      if (reopened?.childId !== undefined) {
        const abandonedChildId = reopened.childId;
        await this.settleChild(
          abandonedChildId,
          (cur) => Run.from(cur).fail(reopened.error, this.now()).patch,
          reopened.parentDriver,
        ).catch(() => {});
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
        const dispatchable: CaseJob =
          openedGeneration === undefined ? enriched : { ...enriched, recordingGeneration: openedGeneration };
        const reattempt = this.reattemptOf({ tenant, scorecardId: id, driverEpoch: epoch });
        const openedAttemptId = attemptLedgerId.get(executionIdOf(job, id));
        const {
          result,
          target: ranOn,
          job: winnerJob,
        } = await this.runResilientCase(dispatchable, {
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
          // queued→running, and the attempt ledger records that this execution reached the machine.
          onStarted: () => {
            void this.stampAttempt(openedAttemptId, "executing", { ...(childId ? { childRunId: childId } : {}) });
            if (childId && runStore) void this.markChildRunning(childId);
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
        if (!(await this.holdsBatch(id, epoch))) {
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
              ...(winnerJob.recordingGeneration !== undefined
                ? { attemptId: attemptIdOf(executionIdOf(job, id), winnerJob.recordingGeneration) }
                : {}),
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
        finalizedByFailure.set(finalizedKey, {
          ...(child !== undefined ? { childId: child.id } : {}),
          executionId: executionIdOf(job, id),
          ...(failedGeneration !== undefined ? { generation: failedGeneration } : {}),
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
      const casesToRun = seed.length > 0 ? dataset.cases.filter((c) => !seededIds.has(c.id)) : dataset.cases;
      // History-weighted split: fast runtimes take proportionally more cases so the shards finish together
      // (speculation stays a safety net, not a scheduler). No history → the old uniform round-robin.
      const history =
        targets.length > 1
          ? await this.shardHistory(tenant, harnessId, harnessVersion, targets)
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
            const reattempt = this.reattemptOf({ tenant, scorecardId: id, driverEpoch: epoch });
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
          onLoser: (outcome, cid) => this.meterLostAttempt(tenant, outcome.result, cid, id),
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
        () => this.holdsBatch(id, epoch),
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
              this.settleJudgedChild(
                id,
                tenant,
                { ...(opts.verdictPolicy ? { verdictPolicy: opts.verdictPolicy } : {}), owner },
                pendingChildSettle,
                finalizedByFailure,
                r,
              ).then((outcome) => {
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
              this.settleJudgedChild(
                id,
                tenant,
                { ...(opts.verdictPolicy ? { verdictPolicy: opts.verdictPolicy } : {}), owner },
                pendingChildSettle,
                finalizedByFailure,
                r,
              ).then((outcome) => {
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
        if (hasChildren) await this.writeBackResults(id, caseToChild, scorecard.results, { scorecardId: id, epoch });
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
      const exported =
        streamExported ??
        (this.deps.exportResults && !exportStream
          ? await this.deps.exportResults(tenant, exportCtx, scorecard.results).catch(() => undefined)
          : undefined);
      if (exported) pushStep("export", exported.status === "failed" ? "failed" : "ok", exportStepMessage(exported));
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
      await this.checkReceiptParity(id, scorecard.results);
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
      const analysis = await offloadAnalysis(this.deps, id, initialBundle, initialPassId(initialBundle));
      // leaderboard model axis: trace observation preferred + spec declaration (command harness only) fallback.
      const declared = modelBindingLabel(harnessSpec?.kind === "command" ? harnessSpec.model : undefined);
      const models = scorecardModels(scorecard, declared);
      // leaderboard judge axis: the judge model(s) that scored this run — inline config + registered model-judge spec.
      const judgeModels = await this.scoring.collectJudgeModels(tenant, judges, judge);
      pushStep("persist", "ok", "aggregated and persisted");
      // If there are child runs: write back the judge/offload-finalized results to the children, then store only runIds instead of the heavy embed
      //  → get hydrates from the children (storage dedup, response shape unchanged). Without children (no runStore), embed as before.
      const hasChildren = caseToChild.size > 0 || seedRunIds.length > 0;
      if (hasChildren) await this.writeBackResults(id, caseToChild, scorecard.results, { scorecardId: id, epoch });
      const extras: ScorecardOutcomeExtras = {
        summary,
        // The stamped-policy verdict aggregate (arch-review 7 §4) — same derivation as the Temporal finalize.
        verdictSummary: verdictSummaryOf(scorecard.results, opts.verdictPolicy),
        ...(worldCohortOf(scorecard.results) ? { world: worldCohortOf(scorecard.results) } : {}),
        models,
        ...(judgeModels.length > 0 ? { judgeModels } : {}),
        ...(exported ? { export: exported } : {}),
        ...(analysis.ref ? { analysisRef: analysis.ref } : {}),
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
          const settlement = batch.succeed({ ...extras, ...(decision ? { decision } : {}), scoring }, this.now());
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
        await this.writeBackResults(id, caseToChild, scorecard.results, { scorecardId: id, epoch });
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
}
