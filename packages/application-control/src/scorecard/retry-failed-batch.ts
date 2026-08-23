import {
  BadRequestError,
  type CaseResult,
  type Dataset,
  type HarnessSpec,
  type JudgeRunConfig,
  NotFoundError,
  OOM_KILLED,
  type ScorecardOrigin,
  type ScorecardRecord,
} from "@everdict/contracts";
import {
  ScorecardBatch,
  caseOutcome,
  caseVerdict,
  newSeededScorecardChildRun,
  resolvePolicyResolution,
} from "@everdict/domain";
import { applyGradingPlan, initialScoringPassId, selectSubsetCases } from "@everdict/domain";
import { collectDeferredTrace } from "../execution/collect-trace.js";
import type { ScoringService } from "../execution/scoring-service.js";
import { OOM_ESCALATION_CAP_MB } from "../ops/oom-boost.js";
import type { CaseOutcomeCommitter } from "./case-outcome-committer.js";
import { ExecutionPlan } from "./execution-plan.js";
import type { TrackOptions } from "./in-process-batch-driver.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";
import { embedHarnessSpec } from "./scorecard-plan.js";

// The in-process driver, as the retry hands work to it — the facade's `track`, whose positional shape the
// call at the end of this file has always used.
export type TrackBatch = (
  id: string,
  tenant: string,
  owner: string,
  dataset: Dataset,
  harnessId: string,
  harnessVersion: string,
  harnessSpec: HarnessSpec | undefined,
  judges: Array<{ id: string; version: string }>,
  runtime: string | undefined,
  judge: JudgeRunConfig | undefined,
  concurrency: number,
  opts?: TrackOptions,
) => Promise<void>;

export interface RetryFailedSupport {
  newId: () => string;
  now: () => string;
  // The service default width, used only when a pre-orchestration source record has none on file.
  concurrency: number;
  scoring: ScoringService;
  commit: CaseOutcomeCommitter;
  // Hydrated read (results from child runs when stored as references) — the facade's own `get`.
  getRecord: (id: string) => Promise<ScorecardRecord | undefined>;
  childEnvelope: (record: { origin?: { causedByRunId?: string } }) => Promise<{ id: string } | undefined>;
  track: TrackBatch;
}

// ── A RETRY IS A NEW BATCH, NOT AN EDIT OF AN OLD ONE ────────────────────────────────────────────────
//
// The lifecycle that turns a terminal batch into its successor: which cases failed (under the SOURCE
// batch's stamped policy), which of them can be re-collected instead of re-run, what the passing results
// are carried in as, and which driver takes the remainder. It stands beside the drivers rather than inside
// one because it produces a batch for whichever driver the deployment has — the workflow when Temporal is
// configured, the in-process loop otherwise.
export class RetryFailedBatch {
  constructor(
    private readonly deps: ScorecardBatchDeps,
    private readonly support: RetryFailedSupport,
  ) {}

  // Retry-failed — a NEW scorecard that re-runs only the failed cases of a terminal batch and carries the passing
  // results over verbatim (full, directly comparable case set; origin.retryOf keeps the lineage). The source record
  // is never mutated — eval history stays immutable. docs/architecture/batch-resilience.md
  async run(input: {
    tenant: string;
    id: string;
    submittedBy?: string;
    // Failure-class filter — re-run only the cases that died in that class (e.g. "infra" after a cluster incident:
    // agent FAILs are legitimate results and stay carried over). Unset = every non-passing case (previous behavior).
    failureClass?: "infra" | "config" | "harness" | "agent";
  }): Promise<ScorecardRecord> {
    const src = await this.support.getRecord(input.id); // hydrated (results from child runs when stored as references)
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
    const orch = src.orchestration ?? { judges: [], concurrency: this.support.concurrency, retries: 1 };
    const record: ScorecardRecord = ScorecardBatch.newQueued({
      id: this.support.newId(),
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
      now: this.support.now(),
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
        // No `.catch(() => r)`: `collectDeferredTrace` is total — every failure it can have comes back as a
        // classified `{collect, infra, retryable}` result, which is the seedable answer. The wrapper read as
        // handling something and could never run (arch-review 64).
        const attempt = await collectDeferredTrace(this.deps, input.tenant, evalCase, r);
        if (attempt.failure === undefined) {
          healed += 1;
          if (orch.judges.length > 0)
            await this.support.scoring
              .applyJudges(
                input.tenant,
                dataset,
                [attempt],
                orch.judges,
                src.runtime,
                input.submittedBy,
                undefined,
                sourcePlan.sealedJudges,
                undefined,
                // …UNDER THE NEW BATCH'S INITIAL PASS (arch-review 56, Wave E). A re-collected case is judged
                // into the retry batch this call is building, so the plane it seals is that batch's — not the
                // source batch's, and not a nameless one, which is what an omitted scope produced.
                { passId: initialScoringPassId(record.id) },
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
        const seededEnvelope = await this.support.childEnvelope(record);
        for (const r of carriedIn) {
          const seededChild = newSeededScorecardChildRun({
            id: this.support.newId(),
            tenant: input.tenant,
            harness: src.harness,
            result: r,
            parentScorecardId: record.id,
            ...(src.runtime ? { runtime: src.runtime } : {}),
            origin: ScorecardBatch.childRunOrigin(record),
            ...(seededEnvelope ? { envelope: seededEnvelope } : {}),
            now: this.support.now(),
          });
          // Through `receiptOf`, so the inherited receipt carries the same judgment identity every other
          // receipt does (the inline literal here carried no judgeClosureDigest — an asymmetry, not a choice).
          const outcome = await receipts.commitCase(
            this.support.commit.receiptOf(record.id, r, {
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
      // The trialled-source degradation is now REDUNDANT, and kept as a belt (arch-review 52, wave 1): the
      // Temporal finalize's gates iterate the plan's (case, trial) pairs, so the accounting reason this
      // exclusion was written for is gone — but retry-failed itself is still single-trial by domain rule
      // (`canRetryFailed` refuses a trialled source, because "the failed cases" is not a statable subset of a
      // pass@k batch), so nothing here can produce a trialled retry to route either way.
      if (this.deps.temporalBatches && this.deps.runStore && !ScorecardBatch.from(src).isMultiTrial()) {
        const workflowId = this.deps.temporalBatches.workflowIdFor(record.id);
        await this.deps.store.update(record.id, {
          orchestration: { ...orch, workflowId },
          steps: [{ ts: this.support.now(), phase: "resume", status: "info", message: resumeNote }],
          updatedAt: this.support.now(),
        });
        try {
          await this.deps.temporalBatches.start(record.id);
          return;
        } catch {
          // Strip the workflow claim and fall through to the in-process loop (same degradation as submit).
          await this.deps.store.update(record.id, { orchestration: orch, updatedAt: this.support.now() });
        }
      }
      await this.support.track(
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
}
