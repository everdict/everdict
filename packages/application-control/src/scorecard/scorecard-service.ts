import {
  BadRequestError,
  type CaseResult,
  type Dataset,
  type HarnessSpec,
  type ScorecardOrigin,
  type ScorecardRecord,
} from "@everdict/contracts";
import {
  CircuitBreaker,
  type Leaderboard,
  ScorecardBatch,
  type ScorecardDiff,
  type ScorecardTrend,
  type TrialDiff,
} from "@everdict/domain";
import { ScoringService } from "../execution/scoring-service.js";
import { assertRuntimeTarget } from "../require-runtime/require-runtime.js";
import { ScorecardAnalyticsService } from "./scorecard-analytics-service.js";
import { ScorecardBatchService } from "./scorecard-batch-service.js";
import { ScorecardIngestService } from "./scorecard-ingest-service.js";
import {
  type IngestScorecardInput,
  type PullIngestInput,
  type RunScorecardInput,
  type ScorecardServiceDeps,
  applyGradingPlan,
  embedHarnessSpec,
  selectSubsetCases,
} from "./scorecard-shared.js";

// Public surface preserved through the R2-b decomposition — the moved declarations stay importable from here.
export {
  IngestScorecardBodySchema,
  PullIngestBodySchema,
  originSource,
  selectSubsetCases,
} from "./scorecard-shared.js";
export type {
  IngestScorecardBody,
  IngestScorecardInput,
  PullIngestBody,
  PullIngestInput,
  RunScorecardInput,
  ScorecardServiceDeps,
} from "./scorecard-shared.js";

// A scorecard run's async lifecycle: dataset resolution (404 if missing) → create record (202) → batch run (runSuite) → aggregate and persist.
// Unit-testable independently of HTTP. AppError is thrown as-is so the caller (server) maps it to a status code.
// Facade over three lifecycle collaborators (docs/architecture/api-route-modularization.md R2-b): batch
// orchestration / ingest / analytics — the external surface (deps, both transports, tests) is unchanged.
export class ScorecardService {
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly concurrency: number;
  // Cooperative-cancellation handles for in-flight batches (for supersede) — assumes a single control-plane process (same as the in-process rendezvous).
  // abort only goes as far as "don't fire the remaining cases": force-killing already-fired backend jobs is a separate problem (follow-up).
  private readonly inFlight = new Map<string, AbortController>();
  // Lifecycle collaborators — the facade is the only composer (they never see each other).
  private readonly batch: ScorecardBatchService;
  private readonly ingestService: ScorecardIngestService;
  private readonly analytics: ScorecardAnalyticsService;

  constructor(private readonly deps: ScorecardServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.concurrency = deps.concurrency ?? 4;
    // Built exactly once, owned by the batch collaborator (runtime health memory for sharded-batch spillover).
    const breaker = deps.breaker ?? new CircuitBreaker();
    // Scoring concern is split into a separate service — live batch and ingest share the same scoring logic (independent of execution).
    const scoring = new ScoringService({
      ...(deps.judges ? { judges: deps.judges } : {}),
      ...(deps.judgeRunner ? { judgeRunner: deps.judgeRunner } : {}),
    });
    const getRecord = (id: string): Promise<ScorecardRecord | undefined> => this.get(id);
    this.batch = new ScorecardBatchService(deps, {
      newId: this.newId,
      now: this.now,
      concurrency: this.concurrency,
      scoring,
      breaker,
      inFlight: this.inFlight,
      getRecord,
    });
    this.ingestService = new ScorecardIngestService(deps, { newId: this.newId, now: this.now, scoring });
    this.analytics = new ScorecardAnalyticsService(deps, { now: this.now, getRecord });
  }

  // Resolve the dataset synchronously (NotFound→404), resolve the harness version/spec, create the record, then run the batch asynchronously.
  async submit(rawInput: RunScorecardInput): Promise<ScorecardRecord> {
    // Deployment policy: the batch's execution target (a registered runtime or self:<runner>) must be specified — 400 if absent (blocks a silent local fallback).
    assertRuntimeTarget(this.deps.requireRuntime, rawInput.runtime);
    // runtime:"auto" — expand to EVERY runtime the tenant has registered and shard across them (same comma-list
    // round-robin; each backend's capacity still admission-controls actual placement via the Scheduler).
    let input = rawInput;
    if (input.runtime === "auto") {
      const ids = this.deps.runtimesFor ? await this.deps.runtimesFor(input.tenant) : [];
      if (ids.length === 0)
        throw new BadRequestError(
          "BAD_REQUEST",
          { tenant: input.tenant },
          'runtime:"auto" needs at least one registered runtime in this workspace.',
        );
      input = { ...input, runtime: ids.join(",") };
    }
    // Placement capability preflight: reject at submit (400) if a chosen runtime can't run this harness — checked per
    // runtime in the comma-list (sharding), before any case is dispatched. self:* targets are skipped inside the preflight.
    if (input.runtime && this.deps.preflightPlacement) {
      for (const target of input.runtime
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean))
        await this.deps.preflightPlacement({ tenant: input.tenant, target, harness: input.harness });
    }
    // Per-batch sink override must name a configured sink ("none" = suppress export for this batch only).
    if (input.traceSink && input.traceSink !== "none" && this.deps.sinkExists) {
      if (!(await this.deps.sinkExists(input.tenant, input.traceSink)))
        throw new BadRequestError(
          "BAD_REQUEST",
          { traceSink: input.traceSink },
          `No trace sink named '${input.traceSink}' is configured in this workspace ("none" suppresses export).`,
        );
    }
    const resolved = await this.deps.datasets.get(input.tenant, input.dataset.id, input.dataset.version || "latest");
    // Partial run — the rest of the pipeline (batch/judge/aggregate) operates on a dataset containing only the selected cases. Marked via record.subset.
    const { cases: selectedCases, subset } = selectSubsetCases(resolved, input.cases);
    // Run-time grading plan — this batch scores with the requested graders instead of each case's defaults (S5).
    const dataset: Dataset = { ...resolved, cases: applyGradingPlan(selectedCases, input.graders) };

    // Resolve the harness version (latest→concrete) + embed the declarative spec. Built-ins (scripted/claude-code) aren't in the registry → as-given.
    // If submit-time ephemeral pins are present, use resolveWithPins with no fallback — evaluation must not pass while silently ignoring the pins.
    const pins = input.harness.pins && Object.keys(input.harness.pins).length > 0 ? input.harness.pins : undefined;
    let harnessVersion = input.harness.version || "latest";
    let harnessSpec: HarnessSpec | undefined;
    if (pins) {
      if (!this.deps.harnesses)
        throw new BadRequestError(
          "BAD_REQUEST",
          { harness: input.harness.id },
          "Pin overrides (pins) are only allowed on harnesses registered in the registry.",
        );
      const spec = await this.deps.harnesses.resolveWithPins(input.tenant, input.harness.id, harnessVersion, pins);
      harnessVersion = spec.version; // the base instance's concrete version (an ephemeral pin does not create a version)
      harnessSpec = spec;
    } else if (this.deps.harnesses) {
      const harnesses = this.deps.harnesses;
      // Registered → embed the resolved spec. Unregistered/built-in (NotFound) → as-given, no spec embedded; a
      // registered-but-invalid spec fails fast here (400) instead of dispatching a specless or malformed job.
      const spec = await embedHarnessSpec(() => harnesses.get(input.tenant, input.harness.id, harnessVersion), {
        id: input.harness.id,
        version: harnessVersion,
      });
      if (spec) {
        harnessVersion = spec.version;
        harnessSpec = spec;
      }
    }

    // provenance: overlay the ephemeral-pin record onto the caller-provided origin. Even if only pins exist (no origin), still record them (reproducibility evidence).
    const origin: ScorecardOrigin | undefined =
      input.origin || pins
        ? { source: input.origin?.source ?? "api", ...(input.origin ?? {}), ...(pins ? { pinOverrides: pins } : {}) }
        : undefined;

    // judge model: request override → workspace default (DB) → none (the inline judge grader is skipped in the agent).
    const judge = input.judge ?? (this.deps.judgeFor ? await this.deps.judgeFor(input.tenant) : undefined);
    const concurrency = input.concurrency ?? this.concurrency;
    const retries = input.retries ?? 1; // transient dispatch retry (throw-only) — default one extra attempt
    // Trials — run each case N times for pass@k / flakiness. Clamp to >=1; 1 keeps single-run behavior byte-identical.
    const trials = input.trials !== undefined ? Math.max(1, Math.floor(input.trials)) : 1;

    // Record assembly is the domain's job (ScorecardBatch.newQueued) — the service only orchestrates.
    const record: ScorecardRecord = ScorecardBatch.newQueued({
      id: this.newId(),
      tenant: input.tenant,
      dataset: { id: dataset.id, version: dataset.version },
      harness: { id: input.harness.id, version: harnessVersion }, // resolved concrete version (never "latest")
      ...(origin ? { origin } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
      ...(subset ? { subset } : {}),
      orchestration: {
        judges: input.judges ?? [],
        ...(input.graders && input.graders.length > 0 ? { graders: input.graders } : {}),
        ...(judge ? { judge } : {}),
        concurrency,
        retries,
        ...(trials > 1 ? { trials } : {}),
        ...(input.traceSink ? { traceSink: input.traceSink } : {}),
        ...(input.oomAutoBoost ? { oomAutoBoost: true } : {}),
      },
      now: this.now(),
    });

    await this.deps.store.create(record);
    // Server-side supersede — reclaim any in-flight batch for the same PR (origin.repo+prNumber) × same (harness, dataset) and
    // replace it with this fire. GitHub-side concurrency only cancels the "workflow" while an already-submitted batch keeps running on the server
    // (preventing an orphaned eval from tying up environments/budget/runner queue). merge/dev fires (no prNumber) are out of scope.
    if (origin?.repo && origin.prNumber !== undefined) {
      await this.supersedeInFlight(input.tenant, origin.repo, origin.prNumber, input.harness.id, dataset.id, record.id);
    }
    // Batch-on-Temporal: when the driver is configured, a durable workflow owns the driver loop (the record is
    // stamped with its workflowId so boot recovery leaves it alone). A failed START degrades gracefully to the
    // in-process loop — the batch must never silently hang on a Temporal outage.
    // Multi-trial batches (N children per case) stay on the in-process loop — the Temporal driver keys planBatch/
    // runBatchCase by caseId and would collapse the trials. docs/architecture/trial-based-verdict.md
    if (this.deps.temporalBatches && trials <= 1) {
      const workflowId = this.deps.temporalBatches.workflowIdFor(record.id);
      await this.deps.store.update(record.id, {
        orchestration: { ...(record.orchestration ?? { judges: [], concurrency, retries }), workflowId },
        updatedAt: this.now(),
      });
      try {
        await this.deps.temporalBatches.start(record.id);
        return (await this.deps.store.get(record.id)) ?? record;
      } catch {
        // Strip the workflow claim and fall through to the in-process loop.
        await this.deps.store.update(record.id, {
          orchestration: record.orchestration ?? { judges: [], concurrency, retries },
          updatedAt: this.now(),
        });
      }
    }
    void this.batch.track(
      record.id,
      input.tenant,
      input.submittedBy ?? input.tenant, // owner — clone a private-repo case via the submitter's personal connection
      dataset,
      input.harness.id,
      harnessVersion,
      harnessSpec,
      input.judges ?? [],
      input.runtime,
      judge,
      // Request parallelism takes precedence, else the service default. Positive integers only (the boundary is enforced by the route/MCP via Zod).
      concurrency,
      {
        retries,
        ...(trials > 1 ? { trials } : {}),
        ...(input.traceSink ? { sinkOverride: input.traceSink } : {}),
        ...(input.oomAutoBoost ? { oomAutoBoost: true } : {}),
      },
    );
    return record;
  }

  // Terminate any queued/running batch under the same (repo, PR, harness, dataset) key as superseded and send an abort signal.
  // Mark status/error first (track's termination respects the aborted guard) + stop firing remaining cases. Already-fired cases
  // complete naturally and are recorded on their child run (not a force-kill). superseded is not succeeded, so baseline/leaderboard stay clean.
  // Cancel a superseded batch's Temporal workflow (cooperative, best-effort — the record is already marked).
  private async cancelWorkflowIfAny(rec: ScorecardRecord | undefined): Promise<void> {
    if (!rec || !ScorecardBatch.from(rec).isWorkflowOwned() || !this.deps.temporalBatches?.cancel) return;
    await this.deps.temporalBatches.cancel(rec.id).catch(() => {});
  }

  private async supersedeInFlight(
    tenant: string,
    repo: string,
    prNumber: number,
    harnessId: string,
    datasetId: string,
    newId: string,
  ): Promise<void> {
    const candidates: ScorecardRecord[] = [];
    for (const status of ["queued", "running"] as const) {
      candidates.push(...(await this.deps.store.list(tenant, { status, dataset: datasetId, harness: harnessId })));
    }
    for (const r of candidates) {
      if (r.id === newId) continue;
      const batch = ScorecardBatch.from(r);
      if (!batch.canSupersede({ repo, prNumber })) continue;
      await this.deps.store.update(r.id, batch.supersede(newId, this.now()));
      this.inFlight.get(r.id)?.abort(); // don't fire remaining cases (cooperative) — track attaches partial results and terminates
      await this.cancelWorkflowIfAny(r); // temporal-owned batch → cancel the workflow too (best-effort)
      // Drop this batch's still-QUEUED scheduler entries — they'd dispatch later only to be discarded.
      this.deps.cancelQueued?.((j) => j.batchId === r.id);
      // Force-kill the already-fired backend jobs (best-effort) — the abort above only stops the un-fired
      // remainder; without this, a superseded 601-case batch keeps burning cluster compute to the end.
      if (this.deps.killCase && this.deps.runStore) {
        const children = await this.deps.runStore.list(tenant, { scorecardId: r.id }).catch(() => []);
        for (const c of children) {
          if (c.status !== "running") continue;
          void this.deps.killCase(tenant, c.runtime ?? r.runtime, c.caseId).catch(() => {});
        }
      }
    }
  }

  // A dispatched scorecard doesn't embed the heavy scorecard (case results), storing only runIds (storage dedup) →
  // get hydrates the scorecard from the child runs' final results (response shape/web/diff identical to the embed era).
  // If an embed already exists (no-runStore / ingest / old record), return it as-is. Without a runStore, hydration is impossible → as-is.
  async get(id: string): Promise<ScorecardRecord | undefined> {
    const record = await this.deps.store.get(id);
    if (!record) return record;
    // Hydrate the scorecard from the child runs when stored as references (response shape identical to the embed era).
    let hydrated = record;
    if (!record.scorecard && record.runIds?.length && this.deps.runStore) {
      const children = await this.deps.runStore.list(record.tenant, { scorecardId: id });
      const results = children.map((c) => c.result).filter((r): r is CaseResult => r !== undefined);
      if (results.length > 0) {
        const harness = `${record.harness.id}@${record.harness.version}`;
        hydrated = { ...record, scorecard: { suiteId: record.dataset.id, harness, results } };
      }
    }
    // Trial roll-up is a pure record derivation — the domain model owns it (ETA stays here: it needs store IO).
    return ScorecardBatch.from(await this.withEta(hydrated)).withTrialSummary();
  }

  // Remaining wall-clock estimate for a RUNNING batch — median duration of its own finished children × remaining
  // waves at the batch's concurrency. Derived on read, never stored; absent until the first child finishes.
  private async withEta(record: ScorecardRecord): Promise<ScorecardRecord> {
    if (record.status !== "running" || !this.deps.runStore || !record.orchestration) return record;
    try {
      const children = await this.deps.runStore.list(record.tenant, { scorecardId: record.id });
      const done = children.filter((c) => c.status === "succeeded" && c.result);
      if (done.length === 0) return record;
      const durations = done
        .map((c) => (new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime()) / 1000)
        .filter((d) => d > 0)
        .sort((a, b) => a - b);
      const median = durations[Math.floor(durations.length / 2)];
      if (median === undefined) return record;
      const total =
        record.subset?.selected ??
        (await this.deps.datasets.get(record.tenant, record.dataset.id, record.dataset.version)).cases.length;
      const remaining = Math.max(0, total - done.length);
      if (remaining === 0) return record;
      const concurrency = Math.max(1, record.orchestration.concurrency);
      return { ...record, etaSeconds: Math.ceil(remaining / concurrency) * Math.ceil(median) };
    } catch {
      return record; // the estimate is a convenience — never let it break the read
    }
  }

  list(tenant?: string): Promise<ScorecardRecord[]> {
    return this.deps.store.list(tenant);
  }

  // Cost/time preflight — "what will this batch cost, and how long will it run?" answered from HISTORY: the per-case
  // usd/duration medians of the last few succeeded batches of the same dataset×harness. Honest when there is no
  // history (basis.samples=0, no estimate) — a guess would be worse than nothing. usd comes from RunRecord.usage
  // (trace-derived), so non-metered workspaces see a 0 median rather than fiction.
  async estimate(input: {
    tenant: string;
    dataset: string;
    harness: string;
    cases?: number;
    concurrency?: number;
  }): Promise<{
    basis: { scorecards: number; samples: number };
    perCase?: { usdMedian: number; durationSecMedian: number };
    estimate?: { cases: number; usd: number; wallSeconds: number; concurrency: number };
  }> {
    const past = (
      await this.deps.store.list(input.tenant, {
        status: "succeeded",
        dataset: input.dataset,
        harness: input.harness,
      })
    ).slice(0, 3); // the most recent batches carry the most representative cost/latency
    const usd: number[] = [];
    const durations: number[] = [];
    if (this.deps.runStore) {
      for (const rec of past) {
        const children = await this.deps.runStore.list(input.tenant, { scorecardId: rec.id });
        for (const c of children) {
          if (c.status !== "succeeded" || !c.result) continue;
          usd.push(c.usage?.usd ?? 0);
          const d = (new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime()) / 1000;
          if (d > 0) durations.push(d);
        }
      }
    }
    const median = (xs: number[]): number | undefined => {
      if (xs.length === 0) return undefined;
      const sorted = [...xs].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const usdMedian = median(usd);
    const durationSecMedian = median(durations);
    const basis = { scorecards: past.length, samples: durations.length };
    if (usdMedian === undefined || durationSecMedian === undefined) return { basis };
    let cases = input.cases;
    if (cases === undefined) {
      try {
        cases = (await this.deps.datasets.get(input.tenant, input.dataset, "latest")).cases.length;
      } catch {
        return { basis, perCase: { usdMedian, durationSecMedian } }; // dataset gone — per-case medians still useful
      }
    }
    const concurrency = Math.max(1, input.concurrency ?? this.concurrency);
    return {
      basis,
      perCase: { usdMedian, durationSecMedian },
      estimate: {
        cases,
        usd: Number((usdMedian * cases).toFixed(4)),
        wallSeconds: Math.ceil(cases / concurrency) * Math.ceil(durationSecMedian),
        concurrency,
      },
    };
  }

  // --- Batch lifecycle — delegated to ScorecardBatchService (resume/retry + Batch-on-Temporal internals).
  resume(id: string): Promise<boolean> {
    return this.batch.resume(id);
  }

  retryFailed(input: {
    tenant: string;
    id: string;
    submittedBy?: string;
    failureClass?: "infra" | "config" | "harness" | "agent";
  }): Promise<ScorecardRecord> {
    return this.batch.retryFailed(input);
  }

  planBatch(id: string): Promise<{ caseIds: string[]; concurrency: number }> {
    return this.batch.planBatch(id);
  }

  runBatchCase(id: string, caseId: string): Promise<{ settled: boolean; skipped?: boolean }> {
    return this.batch.runBatchCase(id, caseId);
  }

  finalizeBatch(id: string): Promise<void> {
    return this.batch.finalizeBatch(id);
  }

  // --- Ingest lifecycle — delegated to ScorecardIngestService (push + pull).
  ingest(input: IngestScorecardInput): Promise<ScorecardRecord> {
    return this.ingestService.ingest(input);
  }

  ingestPull(input: PullIngestInput): Promise<ScorecardRecord> {
    return this.ingestService.ingestPull(input);
  }

  // --- Analytics reads — delegated to ScorecardAnalyticsService.
  diff(
    tenant: string,
    baselineId: string,
    candidateId: string,
    opts: { zThreshold?: number } = {},
  ): Promise<ScorecardDiff & { trials?: TrialDiff }> {
    return this.analytics.diff(tenant, baselineId, candidateId, opts);
  }

  trend(
    tenant: string,
    opts: { datasetId: string; metric: string; harnessId?: string; from?: string; to?: string; baseline?: string },
  ): Promise<ScorecardTrend> {
    return this.analytics.trend(tenant, opts);
  }

  leaderboard(
    tenant: string,
    opts: {
      datasetId: string;
      metric: string;
      harnessId?: string;
      model?: string;
      judgeModel?: string;
      window?: "latest" | "best";
    },
  ): Promise<Leaderboard> {
    return this.analytics.leaderboard(tenant, opts);
  }

  backfillModels(tenant: string): Promise<{ scanned: number; updated: number }> {
    return this.analytics.backfillModels(tenant);
  }
}
