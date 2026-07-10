import {
  type AgentJob,
  AppError,
  BadRequestError,
  type CaseResult,
  type Dataset,
  type EvalCase,
  type HarnessSpec,
  type JudgeRunConfig,
  NotFoundError,
  OOM_KILLED,
  type RunRecord,
  type Scorecard,
  type ScorecardOrigin,
  type ScorecardRecord,
  type ScorecardStep,
  type Suite,
} from "@everdict/contracts";
import {
  type CircuitBreaker,
  type HarnessSecretMaps,
  Run,
  ScorecardBatch,
  type ScorecardOutcomeExtras,
  billingTenant,
  caseVerdict,
  classifyFailure,
  costOf,
  resolveHarnessSecrets,
  scorecardModels,
  summarizeScorecard,
} from "@everdict/domain";
import { collectDeferredTrace } from "../execution/collect-trace.js";
import { executeCase } from "../execution/execute-case.js";
import type { ScoringService } from "../execution/scoring-service.js";
import { AdaptiveConcurrencyGate } from "../ops/adaptive-concurrency.js";
import { OOM_ESCALATION_CAP_MB, executeWithOomBoost } from "../ops/oom-boost.js";
import { executeWithSpillover } from "../ops/runtime-spillover.js";
import { weightedTargets } from "../ops/shard-weights.js";
import { SpeculationController } from "../ops/speculation.js";
import { type Dispatch, runSuite } from "../run-suite.js";
import {
  type ScorecardServiceDeps,
  applyGradingPlan,
  caseReason,
  childKey,
  exportStepMessage,
  offloadResults,
  selectSubsetCases,
} from "./scorecard-shared.js";

// Batch-orchestration collaborator behind the ScorecardService facade (docs/architecture/api-route-modularization.md
// R2-b): the live batch lifecycle — the in-process track loop, the Batch-on-Temporal internals (plan/run/finalize),
// restart resume, and retry-failed. Composed only by the facade; shared plumbing (ids/clock/scoring/breaker/inFlight)
// is handed in so behavior is identical to the pre-split single class.
export class ScorecardBatchService {
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly concurrency: number;
  private readonly scoring: ScoringService;
  private readonly inFlight: Map<string, AbortController>;
  // Runtime health memory for sharded-batch spillover (docs/architecture/batch-resilience.md).
  private readonly breaker: CircuitBreaker;
  private readonly getRecord: (id: string) => Promise<ScorecardRecord | undefined>;

  constructor(
    private readonly deps: ScorecardServiceDeps,
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
  async resume(id: string): Promise<boolean> {
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
      // Re-apply the recorded grading plan — resume must score exactly like the original submit.
      dataset = { ...resolved, cases: applyGradingPlan(cases, orch.graders) };
      if (this.deps.runStore) {
        const children = await this.deps.runStore.list(rec.tenant, { scorecardId: id });
        // Latest child per case wins (a batch resumed more than once has several children for a re-run case).
        const latestByCase = ScorecardBatch.latestChildPerCase(children);
        for (const c of latestByCase.values()) {
          if (c.status === "succeeded" && c.result) {
            seed.push(c.result);
            seedRunIds.push(c.id);
          } else if (c.status === "running" || c.status === "queued") {
            // Mid-flight when the process died. ADOPT first: the orchestrator job the old process submitted may
            // still be running (or already finished) — harvest its result instead of re-dispatching and paying
            // for the same execution twice. Only when nothing is adoptable does the case fall to re-dispatch.
            const adoptable = this.deps.adoptCase
              ? await this.deps.adoptCase(rec.tenant, c.runtime ?? rec.runtime, c.caseId).catch(() => undefined)
              : undefined;
            if (adoptable) {
              adopted += 1;
              await this.deps.runStore.update(c.id, Run.from(c).adopt(adoptable, this.now()));
              seed.push(adoptable);
              seedRunIds.push(c.id);
              continue;
            }
            await this.deps.runStore.update(
              c.id,
              Run.from(c).fail(
                { code: "INTERRUPTED", message: "Interrupted by a control-plane restart — re-dispatched on resume." },
                this.now(),
              ),
            );
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
      try {
        harnessSpec =
          pins && Object.keys(pins).length > 0
            ? await this.deps.harnesses.resolveWithPins(rec.tenant, rec.harness.id, rec.harness.version, pins)
            : await this.deps.harnesses.get(rec.tenant, rec.harness.id, rec.harness.version);
      } catch {
        // unregistered/built-in → no spec embedded (same as submit)
      }
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
        ...(orch.traceSink ? { sinkOverride: orch.traceSink } : {}),
        ...(orch.oomAutoBoost ? { oomAutoBoost: true } : {}),
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
      judges: Array<{ id: string; version: string }>;
      judge?: JudgeRunConfig;
      retries: number;
      concurrency: number;
      secretMap?: HarnessSecretMaps;
      caseIndex: Map<string, EvalCase>; // placement target already assigned (stable round-robin by selected index)
      targets: string[]; // the shard list — spillover candidates (empty = no runtime selection)
      speculation?: SpeculationController; // tail-straggler duplication (sharded batches only)
      memoryBoostMb?: Record<string, number>; // OOM escalation of a Temporal-owned retry (origin.memoryBoostMb)
      oomAutoBoost?: boolean; // in-batch OOM auto-boost (orchestration.oomAutoBoost)
      traceSink?: string; // per-batch sink override (orchestration.traceSink)
      doneIds: Set<string>;
      stepChain: Promise<void>;
    }
  >();

  private async buildBatchContext(id: string): Promise<NonNullable<ReturnType<typeof this.batchContexts.get>>> {
    const rec = await this.deps.store.get(id);
    if (!rec) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "scorecard not found.");
    const orch = rec.orchestration;
    if (!orch) throw new BadRequestError("BAD_REQUEST", { scorecard: id }, "This batch has no orchestration inputs.");
    const resolved = await this.deps.datasets.get(rec.tenant, rec.dataset.id, rec.dataset.version);
    const { cases: selected } = selectSubsetCases(
      resolved,
      rec.subset ? { ids: rec.subset.ids, tags: rec.subset.tags, limit: rec.subset.limit } : undefined,
    );
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
      try {
        harnessSpec =
          pins && Object.keys(pins).length > 0
            ? await this.deps.harnesses.resolveWithPins(rec.tenant, rec.harness.id, rec.harness.version, pins)
            : await this.deps.harnesses.get(rec.tenant, rec.harness.id, rec.harness.version);
      } catch {
        // unregistered/built-in → no spec embedded (same as submit)
      }
    }
    const owner = rec.createdBy ?? rec.tenant;
    const secretMap =
      harnessSpec && this.deps.scopedSecretsFor ? await this.deps.scopedSecretsFor(rec.tenant, owner) : undefined;
    const doneIds = new Set<string>();
    if (this.deps.runStore) {
      const children = await this.deps.runStore.list(rec.tenant, { scorecardId: id });
      const latest = ScorecardBatch.latestChildPerCase(children);
      for (const c of latest.values()) if (c.status === "succeeded" && c.result) doneIds.add(c.caseId);
    }
    const ctx = {
      tenant: rec.tenant,
      owner,
      dataset: { ...resolved, cases } as Dataset,
      harnessId: rec.harness.id,
      harnessVersion: rec.harness.version,
      ...(harnessSpec ? { harnessSpec } : {}),
      judges: orch.judges,
      ...(orch.judge ? { judge: orch.judge } : {}),
      retries: orch.retries,
      concurrency: orch.concurrency,
      ...(secretMap ? { secretMap } : {}),
      caseIndex,
      targets,
      ...(rec.origin?.memoryBoostMb ? { memoryBoostMb: rec.origin.memoryBoostMb } : {}),
      ...(rec.orchestration?.oomAutoBoost ? { oomAutoBoost: true } : {}),
      ...(orch.traceSink ? { traceSink: orch.traceSink } : {}),
      // Tail speculation — sharded batches only. The controller lives with the batch context (rebuilt with
      // empty duration history on a CP restart — it re-learns the median from the resumed cases).
      ...(targets.length > 1
        ? {
            speculation: new SpeculationController({
              targets,
              tenant: rec.tenant,
              breaker: this.breaker,
              totalCases: caseIndex.size,
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
      if (!batch.isTerminal()) await this.deps.store.update(id, batch.start(this.now()));
    }
    await this.appendBatchStep(id, {
      phase: "dispatch",
      status: "started",
      message: `Running ${remaining.length} case(s) via Temporal workflow${ctx.doneIds.size > 0 ? ` (${ctx.doneIds.size} finished case(s) kept)` : ""}`,
    });
    return { caseIds: remaining, concurrency: ctx.concurrency };
  }

  // runBatchCase — execute + settle exactly one case (idempotent). Mirrors the in-process track dispatch closure:
  // budget admit → child run → secret resolve → executeCase (CP-side transient retry by failure class) → settle →
  // per-case judges → progress step. Kept deliberately parallel to track() — the two drivers share every primitive
  // (executeCase, classifyFailure, applyJudges, billing), only the loop ownership differs.
  async runBatchCase(id: string, caseId: string): Promise<{ settled: boolean; skipped?: boolean }> {
    const ctx = this.batchContexts.get(id) ?? (await this.buildBatchContext(id));
    // Superseded mid-flight (a newer fire reclaimed this batch) — don't spend more compute/LLM on it. The workflow
    // is cancelled cooperatively by supersede; this guard covers activities already in the queue.
    const current = await this.deps.store.get(id);
    if (current && ScorecardBatch.from(current).isSuperseded()) return { settled: true, skipped: true };
    if (ctx.doneIds.has(caseId)) return { settled: true, skipped: true };
    const evalCase = ctx.caseIndex.get(caseId);
    if (!evalCase) throw new NotFoundError("NOT_FOUND", { scorecard: id, caseId }, "case not in this batch.");

    this.deps.budget?.admit(ctx.tenant);
    const runStore = this.deps.runStore;
    let child: RunRecord | undefined;
    if (runStore) {
      child = ScorecardBatch.newChildRun({
        id: this.newId(),
        tenant: ctx.tenant,
        harness: { id: ctx.harnessId, version: ctx.harnessVersion },
        caseId,
        parentScorecardId: id,
        ...(evalCase.placement?.target ? { runtime: evalCase.placement.target } : {}),
        now: this.now(),
      });
      await runStore.create(child);
    }
    const baseJob: AgentJob = {
      evalCase,
      harness: { id: ctx.harnessId, version: ctx.harnessVersion },
      tenant: ctx.tenant,
      batchId: id, // scheduler-side reclaim key (supersede / speculation-loser queue cancel)
      runId: `evd-${id}-${caseId}`, // trace correlation (Temporal path parity — no trial fan-out here)
      priority: "batch", // fan-out work — yields the queue to interactive single runs
      ...(ctx.owner ? { submittedBy: ctx.owner } : {}),
      ...(ctx.harnessSpec ? { harnessSpec: ctx.harnessSpec } : {}),
      ...(ctx.judge ? { judge: ctx.judge } : {}),
    };
    let result: CaseResult | undefined;
    let ranOn: string | undefined; // the runtime that actually ran the case (spillover provenance)
    for (let attempt = 0; ; attempt++) {
      try {
        const resolved =
          ctx.secretMap && baseJob.harnessSpec
            ? { ...baseJob, harnessSpec: resolveHarnessSecrets(baseJob.harnessSpec, ctx.secretMap) }
            : baseJob;
        // OOM escalation parity with the in-process loop — a Temporal-owned retry applies its boost the same way.
        const boostMb = ctx.memoryBoostMb?.[caseId];
        const jobToRun =
          boostMb !== undefined && resolved.harnessSpec?.kind === "command"
            ? {
                ...resolved,
                harnessSpec: {
                  ...resolved.harnessSpec,
                  resources: { ...resolved.harnessSpec.resources, memoryMb: boostMb },
                },
              }
            : resolved;
        // Spillover: same failover as the in-process loop — a retryable infra failure moves the case to the
        // next healthy runtime of the shard list before the transient retry burns attempts on a dead cluster.
        // Tail speculation on top (same semantics as the in-process loop): straggler duplicate, first result wins.
        const exec = (j: AgentJob): Promise<{ result: CaseResult; target?: string }> =>
          executeWithSpillover((jj) => executeCase(this.deps, ctx.owner, jj), j, {
            targets: ctx.targets,
            tenant: ctx.tenant,
            breaker: this.breaker,
            onSpill: (cid, from, to, code) => {
              this.deps.onOrchestrationEvent?.({ kind: "spillover", from, to, code });
              void this.appendBatchStep(id, {
                phase: "case",
                status: "info",
                message: `${cid}: runtime spillover ${from} → ${to} (${code})`,
                caseId: cid,
              });
            },
          });
        // In-batch OOM auto-boost — same opt-in doubling as the in-process loop (parity by construction).
        const outcome = await executeWithOomBoost(
          (j) => (ctx.speculation ? ctx.speculation.run(exec, j) : exec(j)),
          jobToRun,
          {
            enabled: ctx.oomAutoBoost ?? false,
            onBoost: (cid, fromMb, toMb) => {
              this.deps.onOrchestrationEvent?.({ kind: "oom_escalated", memoryMb: toMb });
              void this.appendBatchStep(id, {
                phase: "case",
                status: "info",
                message: `${cid}: OOM auto-boost ${fromMb} → ${toMb}Mb (in-batch retry)`,
                caseId: cid,
              });
            },
          },
        );
        result = outcome.result;
        ranOn = outcome.target;
        break;
      } catch (err) {
        const failure = classifyFailure(err, "dispatch");
        if (attempt >= ctx.retries || !failure.retryable) {
          const message = err instanceof Error ? err.message : String(err);
          result = {
            caseId,
            harness: `${ctx.harnessId}@${ctx.harnessVersion}`,
            trace: [{ t: 0, kind: "error", message }],
            snapshot: { kind: "prompt", output: "" },
            scores: [
              { graderId: "dispatch", metric: "error", value: 0, pass: false, detail: `[${failure.class}] ${message}` },
            ],
            failure,
          };
          break;
        }
        await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
      }
    }
    const bill = billingTenant(result, ctx.tenant);
    if (bill) this.deps.budget?.settle(bill, costOf(result));
    this.deps.usage?.meterCase(result, ctx.tenant); // meter-only billing usage (own-pays runs skip themselves)
    // Per-case judge scoring — the same "judge the moment the case lands" semantics as the in-process judge stream.
    if (ctx.judges.length > 0) {
      await this.scoring.applyJudges(ctx.tenant, ctx.dataset, [result], ctx.judges).catch(() => {});
    }
    if (runStore && child)
      await runStore.update(child.id, {
        ...Run.from(child).succeed(result, this.now()),
        // Provenance: record the runtime that ACTUALLY ran the case (differs from the assigned one after a spillover).
        ...(ranOn ? { runtime: ranOn } : {}),
      });
    ctx.doneIds.add(caseId);
    const v = caseVerdict(result);
    const reason = caseReason(result);
    const verdict = v == null ? "no result" : v ? "PASS" : "FAIL";
    await this.appendBatchStep(id, {
      phase: "case",
      status: v === false ? "failed" : "ok",
      message: `${caseId} → ${verdict}${reason ? ` · ${reason}` : ""}`,
      caseId,
    });
    return { settled: true };
  }

  // finalizeBatch — aggregate the children into the final record (summary/models/judges/export) and notify.
  async finalizeBatch(id: string): Promise<void> {
    const ctx = this.batchContexts.get(id) ?? (await this.buildBatchContext(id));
    const rec = await this.deps.store.get(id);
    if (!rec) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "scorecard not found.");
    const children = this.deps.runStore ? await this.deps.runStore.list(ctx.tenant, { scorecardId: id }) : [];
    const latest = ScorecardBatch.latestChildPerCase(children);
    const order = new Map([...ctx.caseIndex.keys()].map((cid, i) => [cid, i] as const));
    const results = [...latest.values()]
      .map((c) => c.result)
      .filter((r): r is CaseResult => r !== undefined)
      .sort((a, b) => (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0));
    const scorecard: Scorecard = {
      suiteId: rec.dataset.id,
      harness: `${ctx.harnessId}@${ctx.harnessVersion}`,
      results,
    };
    await offloadResults(this.deps, id, results);
    // Trace-sink export (batched at finalize on the Temporal path — per-case export streaming stays in-process-only).
    const exported = this.deps.exportResults
      ? await this.deps
          .exportResults(
            ctx.tenant,
            {
              scorecardId: id,
              dataset: `${rec.dataset.id}@${rec.dataset.version}`,
              harness: scorecard.harness,
              ...(ctx.traceSink ? { sinkOverride: ctx.traceSink } : {}),
            },
            results,
          )
          .catch(() => undefined)
      : undefined;
    const declared = ctx.harnessSpec?.kind === "command" ? ctx.harnessSpec.model : undefined;
    const judgeModels = await this.scoring.collectJudgeModels(ctx.tenant, ctx.judges, ctx.judge);
    const runIds = [...latest.values()].map((c) => c.id);
    await this.appendBatchStep(id, { phase: "persist", status: "ok", message: "aggregated and persisted (temporal)" });
    // Read-guarded terminal write: a supersede that raced the workflow's finalize already settled the record —
    // never revive it to succeeded (first terminal write wins; a replaced batch also skips its notification).
    const final = await this.deps.store.get(id);
    const batch = ScorecardBatch.from(final ?? rec);
    if (batch.isTerminal()) {
      this.batchContexts.delete(id);
      return;
    }
    await this.deps.store.update(
      id,
      batch.succeed(
        {
          summary: summarizeScorecard(scorecard),
          models: scorecardModels(scorecard, declared),
          ...(judgeModels.length > 0 ? { judgeModels } : {}),
          ...(exported ? { export: exported } : {}),
          steps: final?.steps ?? [],
          ...(runIds.length > 0 ? { runIds } : { scorecard }),
        },
        this.now(),
      ),
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
    // Class selection: a result with a classified failure matches its class; a plain grader FAIL (no failure field)
    // is the agent's own outcome → class "agent". Unset = every non-passing case.
    // A collect-stage failure is retryable even when the ground-truth verdict PASSED — the case is incomplete
    // (trace missing, observation/judge scores never ran), and its retry is a re-collect, not a re-run.
    const incomplete = (r: CaseResult): boolean => r.failure?.stage === "collect";
    const classOf = (r: CaseResult): string | undefined =>
      caseVerdict(r) === true && !incomplete(r) ? undefined : (r.failure?.class ?? "agent");
    const failed = results.filter((r) =>
      input.failureClass ? classOf(r) === input.failureClass : caseVerdict(r) !== true || incomplete(r),
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
      try {
        harnessSpec =
          pins && Object.keys(pins).length > 0
            ? await this.deps.harnesses.resolveWithPins(input.tenant, src.harness.id, src.harness.version, pins)
            : await this.deps.harnesses.get(input.tenant, src.harness.id, src.harness.version);
      } catch {
        // unregistered/built-in → no spec embedded (same as submit)
      }
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
            await this.scoring.applyJudges(input.tenant, dataset, [attempt], orch.judges).catch(() => {});
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

      // Temporal parity: when the batch driver is configured, the retry batch is workflow-owned too — a CP
      // restart mid-retry must not lose it. Seeds (passes + recovered) are MATERIALIZED as succeeded child runs
      // first, so the idempotent planBatch naturally skips them and finalize aggregates them; the workflow then
      // drives only the re-dispatch remainder. Start failure degrades to the in-process loop (same as submit).
      if (this.deps.temporalBatches && this.deps.runStore) {
        for (const r of [...seed, ...recovered]) {
          await this.deps.runStore.create(
            ScorecardBatch.newSeededChildRun({
              id: this.newId(),
              tenant: input.tenant,
              harness: src.harness,
              result: r,
              parentScorecardId: record.id,
              ...(src.runtime ? { runtime: src.runtime } : {}),
              now: this.now(),
            }),
          );
        }
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
          seed: [...seed, ...recovered],
          retries: orch.retries,
          ...(boosted > 0 ? { memoryBoostMb } : {}),
          ...(orch.traceSink ? { sinkOverride: orch.traceSink } : {}),
          resumeNote,
        },
      );
    })();
    return record;
  }

  // Reflect the case results finalized by batch judge/offload into each child run (since we don't store the embed, get's hydration source must be current).
  // Update each result onto its run via the caseId → childId mapping.
  private async writeBackResults(caseToChild: Map<string, string>, results: CaseResult[]): Promise<void> {
    const store = this.deps.runStore;
    if (!store) return;
    for (const r of results) {
      const childId = caseToChild.get(childKey(r.caseId, r.trial));
      if (childId) await store.update(childId, { result: r, updatedAt: this.now() });
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
    } = {},
  ): Promise<void> {
    const trials = opts.trials ?? 1;
    // If supersede already reclaimed this batch (or it otherwise settled), don't start — never revive a
    // terminal record back to running.
    const opening = await this.deps.store.get(id);
    if (!opening) return;
    const openingBatch = ScorecardBatch.from(opening);
    if (openingBatch.isTerminal()) return;
    // Register the cooperative-cancellation handle — when supersedeInFlight aborts, runSuite stops firing remaining cases.
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    await this.deps.store.update(id, openingBatch.start(this.now()));
    // Progress (step) timeline — append as the run proceeds + persist incrementally so the web shows "how far / what" it's doing.
    const steps: ScorecardStep[] = [];
    const pushStep = (p: string, status: ScorecardStep["status"], message: string, caseId?: string): void => {
      steps.push({ ts: this.now(), phase: p, status, message, ...(caseId ? { caseId } : {}) });
    };
    const flushSteps = (): Promise<unknown> => this.deps.store.update(id, { steps: [...steps], updatedAt: this.now() });
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
    const dispatch: Dispatch = async (job) => {
      this.deps.budget?.admit(tenant); // throws if over budget → batch fails
      const enriched: AgentJob = {
        ...job,
        tenant,
        batchId: id, // scheduler-side reclaim key (supersede / speculation-loser queue cancel)
        // Trace correlation, derivable by observers: evd-<batchId>-<caseId>[-t<n>] (live-observability).
        runId: `evd-${id}-${job.evalCase.id}${job.trial !== undefined ? `-t${job.trial}` : ""}`,
        priority: "batch", // fan-out work — yields the queue to interactive single runs
        // owner (submitter subject) — self-hosted runner dispatch-ownership check + lease-queue key (same as a single run).
        ...(owner ? { submittedBy: owner } : {}),
        ...(harnessSpec ? { harnessSpec } : {}),
        ...(judge ? { judge } : {}),
      };
      const runStore = this.deps.runStore;
      // Child run (if any): create as running. Tagged with parentScorecardId, hidden from the activity list by default.
      let child: RunRecord | undefined;
      if (runStore) {
        child = ScorecardBatch.newChildRun({
          id: this.newId(),
          tenant,
          harness: { id: harnessId, version: harnessVersion },
          caseId: job.evalCase.id,
          parentScorecardId: id,
          ...(runtime ? { runtime } : {}), // propagate the batch's runtime to the child too — the queue's runtime-lane axis
          now: this.now(),
        });
        await runStore.create(child);
        caseToChild.set(childKey(job.evalCase.id, job.trial), child.id);
      }
      try {
        // Resolve env secret references (just before dispatch). If a referenced secret is missing, resolveHarnessSecrets throws → this case is isolated as a failure.
        const resolved =
          secretMap && enriched.harnessSpec
            ? { ...enriched, harnessSpec: resolveHarnessSecrets(enriched.harnessSpec, secretMap) }
            : enriched;
        // OOM escalation — a retry re-runs a memory-killed case with the boosted memoryMb on the job only.
        const boostMb = opts.memoryBoostMb?.[job.evalCase.id];
        const jobToRun =
          boostMb !== undefined && resolved.harnessSpec?.kind === "command"
            ? {
                ...resolved,
                harnessSpec: {
                  ...resolved.harnessSpec,
                  resources: { ...resolved.harnessSpec.resources, memoryMb: boostMb },
                },
              }
            : resolved;
        // Spillover: a retryable infra failure on the assigned runtime moves the case to the next healthy runtime
        // of the shard list; the shared breaker skips runtimes with a known outage entirely.
        // Tail speculation on top: at the batch tail a straggler gets a duplicate on another healthy runtime and
        // the first result wins (the duplicate runs through the same spillover-wrapped executor).
        const exec = (j: AgentJob): Promise<{ result: CaseResult; target?: string }> =>
          executeWithSpillover((jj) => executeCase(this.deps, owner, jj), j, {
            targets,
            tenant,
            breaker: this.breaker,
            onSpill: (caseId, from, to, code) => {
              this.deps.onOrchestrationEvent?.({ kind: "spillover", from, to, code });
              pushStep("case", "info", `${caseId}: runtime spillover ${from} → ${to} (${code})`, caseId);
              void flushSteps();
            },
          });
        // In-batch OOM auto-boost (opt-in): an OOM_KILLED throw re-dispatches this case with doubled job-only
        // memory up to the cap — no retry-failed round-trip. Wraps speculation/spillover so a boosted attempt
        // rides the same failover machinery.
        const { result, target: ranOn } = await executeWithOomBoost(
          (j) => (speculation ? speculation.run(exec, j) : exec(j)),
          jobToRun,
          {
            enabled: opts.oomAutoBoost ?? false,
            onBoost: (cid, fromMb, toMb) => {
              this.deps.onOrchestrationEvent?.({ kind: "oom_escalated", memoryMb: toMb });
              pushStep("case", "info", `${cid}: OOM auto-boost ${fromMb} → ${toMb}Mb (in-batch retry)`, cid);
              void flushSteps();
            },
          },
        );
        // Cost attribution: managed=batch tenant · workspace-shared runner=that workspace (team resource) · personal runner=own-pays. Same as a single run.
        const bill = billingTenant(result, tenant);
        if (bill) this.deps.budget?.settle(bill, costOf(result));
        this.deps.usage?.meterCase(result, tenant); // meter-only billing usage (own-pays runs skip themselves)
        // Provenance: record the runtime that ACTUALLY ran the case (differs from the assigned one after a spillover).
        if (runStore && child)
          await runStore.update(child.id, {
            ...Run.from(child).succeed(result, this.now()),
            ...(ranOn ? { runtime: ranOn } : {}),
          });
        return result;
      } catch (err) {
        if (runStore && child) {
          const error =
            err instanceof AppError
              ? { code: err.code, message: err.message }
              : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
          await runStore.update(child.id, Run.from(child).fail(error, this.now()));
        }
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
      const judgeStream = await this.scoring.createJudgeStream(tenant, dataset, judges, runtime);
      // sink-export streaming (D5) — if the harness selected a sink, export each case to the team platform the moment it completes (after judging)
      // (live visibility + whatever went out survives even if the batch dies midway). If not wired,
      // the success path below falls back to exportResults (batched) (no regression).
      const exportCtx = {
        scorecardId: id,
        dataset: `${dataset.id}@${dataset.version}`,
        harness: `${harnessId}@${harnessVersion}`,
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
          const v = caseVerdict(r);
          const reason = caseReason(r);
          const verdict = v == null ? "no result" : v ? "PASS" : "FAIL";
          pushStep(
            "case",
            v === false ? "failed" : "ok",
            `${r.caseId} → ${verdict}${reason ? ` · ${reason}` : ""}`,
            r.caseId,
          );
          void flushSteps();
          // After supersede, skip firing judges too (don't spend more LLM cost on a reclaimed batch).
          if (!controller.signal.aborted) {
            const judged = judgeStream.push(r);
            // Case-completion chaining: export the case only 'after' its judge score is attached — skip new fires after abort
            // (already-fired exports complete naturally; the supersede path joins them and records a partial outcome).
            if (exportStream) {
              void judged.then(() => {
                if (!controller.signal.aborted) exportStream.push(r);
              });
            }
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
        // Exports already sent via streaming are joined and recorded as a partial outcome (for tracking — superseded ≠ succeeded,
        // so baseline/leaderboard stay clean). If no cases went out, skip recording (an empty outcome is noise).
        const exportedPartial = exportStream ? await exportStream.settle().catch(() => undefined) : undefined;
        pushStep(
          "supersede",
          "info",
          "Replaced by a newer fire of the same PR — remaining cases not fired, only partial results kept",
        );
        const hasChildren = caseToChild.size > 0 || seedRunIds.length > 0;
        if (hasChildren) await this.writeBackResults(caseToChild, scorecard.results);
        // The record was already marked superseded by supersedeInFlight — settle it with the partial outcome
        // (a legal re-write of a superseded record; the domain rejects it over succeeded/failed).
        const reclaimed = await this.deps.store.get(id);
        if (reclaimed)
          await this.deps.store.update(
            id,
            ScorecardBatch.from(reclaimed).settleSuperseded(
              {
                ...(scorecard.results.length > 0 ? { summary: summarizeScorecard(scorecard) } : {}),
                ...(exportedPartial?.cases?.length ? { export: exportedPartial } : {}),
                steps: [...steps],
                ...(hasChildren && seedChildBacked
                  ? { runIds: [...seedRunIds, ...caseToChild.values()] }
                  : { scorecard, ...(hasChildren ? { runIds: [...seedRunIds, ...caseToChild.values()] } : {}) }),
              },
              this.now(),
            ),
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
      if (judges.length > 0) {
        pushStep("judges", "ok", "judges applied");
        await flushSteps();
      }
      phase = "offload";
      await offloadResults(this.deps, id, scorecard.results); // os-use screenshots → object storage (slim record)
      // Trace-sink export (when configured) — even if it fails, the scorecard succeeds (recorded via outcome.status only, no error.phase).
      // With streaming (exportStream), cases already went out right after judging — here it's just joining remaining tasks + summing the outcome.
      // If not wired, fall back to the current batched export. TraceSinkService already doesn't throw, but isolate here too just in case.
      const exported = exportStream
        ? await exportStream.settle().catch(() => undefined)
        : this.deps.exportResults
          ? await this.deps.exportResults(tenant, exportCtx, scorecard.results).catch(() => undefined)
          : undefined;
      if (exported) pushStep("export", exported.status === "failed" ? "failed" : "ok", exportStepMessage(exported));
      phase = "persist";
      const summary = summarizeScorecard(scorecard);
      // leaderboard model axis: trace observation preferred + spec declaration (command harness only) fallback.
      const declared = harnessSpec?.kind === "command" ? harnessSpec.model : undefined;
      const models = scorecardModels(scorecard, declared);
      // leaderboard judge axis: the judge model(s) that scored this run — inline config + registered model-judge spec.
      const judgeModels = await this.scoring.collectJudgeModels(tenant, judges, judge);
      pushStep("persist", "ok", "aggregated and persisted");
      // If there are child runs: write back the judge/offload-finalized results to the children, then store only runIds instead of the heavy embed
      //  → get hydrates from the children (storage dedup, response shape unchanged). Without children (no runStore), embed as before.
      const hasChildren = caseToChild.size > 0 || seedRunIds.length > 0;
      if (hasChildren) await this.writeBackResults(caseToChild, scorecard.results);
      const extras: ScorecardOutcomeExtras = {
        summary,
        models,
        ...(judgeModels.length > 0 ? { judgeModels } : {}),
        ...(exported ? { export: exported } : {}),
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
          await this.deps.store.update(id, batch.settleSuperseded(extras, this.now()));
        } else if (!batch.isTerminal()) {
          await this.deps.store.update(id, batch.succeed(extras, this.now()));
        }
        // else: a raced supersede settled the record before the abort signal reached this loop — first
        // terminal write wins, the late success is a no-op skip.
      }
    } catch (err) {
      const base =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
      pushStep(phase, "failed", base.message);
      // Preserve partial results — on a post-dispatch (judge/offload) failure, persist the case results already gathered for visibility.
      // With child runs, mirror the success path: runIds references (partial) instead of embed + write back results to the children.
      const hasChildren = caseToChild.size > 0 || seedRunIds.length > 0;
      if (scorecard && hasChildren) await this.writeBackResults(caseToChild, scorecard.results);
      const declared = harnessSpec?.kind === "command" ? harnessSpec.model : undefined;
      const extras: ScorecardOutcomeExtras = {
        steps: [...steps],
        ...(hasChildren ? { runIds: [...seedRunIds, ...caseToChild.values()] } : {}),
        ...(scorecard
          ? {
              summary: summarizeScorecard(scorecard),
              models: scorecardModels(scorecard, declared),
              ...(hasChildren ? {} : { scorecard }), // with children, skip embed (get hydrates)
            }
          : {}),
      };
      const settled = await this.deps.store.get(id);
      if (settled) {
        const batch = ScorecardBatch.from(settled);
        if (controller.signal.aborted) {
          // A failure after supersede isn't reported as a failure (a reclaimed batch's leftover errors are noise) — keep superseded.
          await this.deps.store.update(
            id,
            batch.settleSuperseded({ ...extras, error: { ...base, phase } }, this.now()),
          );
        } else if (!batch.isTerminal()) {
          await this.deps.store.update(id, batch.fail({ ...base, phase }, extras, this.now()));
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
