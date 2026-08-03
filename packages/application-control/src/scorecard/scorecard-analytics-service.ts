import {
  AppError,
  BadRequestError,
  NotFoundError,
  type Scorecard,
  type ScorecardRecord,
  UpstreamError,
} from "@everdict/contracts";
import {
  type AnalysisConfig,
  type AnalysisResult,
  type Leaderboard,
  type ScorecardDiff,
  type ScorecardTrend,
  type TrialDiff,
  computeAnalysis,
  diffScorecards,
  diffTrials,
  leaderboard,
  scorecardModels,
  trendSeries,
} from "@everdict/domain";
import { type ScorecardServiceDeps, analysisArtifactKey } from "./scorecard-shared.js";

// Analytics collaborator behind the ScorecardService facade (docs/architecture/api-route-modularization.md R2-b):
// read-side derivations over the store + the pure @everdict/domain aggregations — diff / trend / leaderboard /
// backfillModels. Composed only by the facade; getRecord is the facade's hydrating get (child-run references →
// embedded scorecard).
export class ScorecardAnalyticsService {
  private readonly now: () => string;
  private readonly getRecord: (id: string) => Promise<ScorecardRecord | undefined>;

  constructor(
    private readonly deps: ScorecardServiceDeps,
    shared: { now: () => string; getRecord: (id: string) => Promise<ScorecardRecord | undefined> },
  ) {
    this.now = shared.now;
    this.getRecord = shared.getRecord;
  }

  // baseline vs candidate comparison — metric deltas over the same cases + pass transitions (regression/improvement). Both must be owned by this workspace and complete.
  // When either side ran repeated trials, the pass-transition regressions above are last-trial-noisy — attach the
  // statistically-gated trial diff (two-proportion z-test) as the authoritative regression signal. docs/architecture/trial-based-verdict.md
  async diff(
    tenant: string,
    baselineId: string,
    candidateId: string,
    opts: { zThreshold?: number } = {},
  ): Promise<ScorecardDiff & { trials?: TrialDiff }> {
    const baseline = await this.requireSucceeded(tenant, baselineId);
    const candidate = await this.requireSucceeded(tenant, candidateId);
    const diff = diffScorecards(baseline, candidate);
    const hasTrials =
      baseline.results.some((r) => r.trial !== undefined) || candidate.results.some((r) => r.trial !== undefined);
    return hasTrials ? { ...diff, trials: diffTrials(baseline, candidate, opts) } : diff;
  }

  // Time-range trend / regression-over-time — line up a (dataset, metric)'s scorecards chronologically and flag regressions vs the baseline.
  // Computed from the list (lightweight summary) alone — no heavy traces needed. ScorecardRecord structurally satisfies TrendCard.
  async trend(
    tenant: string,
    opts: { datasetId: string; metric: string; harnessId?: string; from?: string; to?: string; baseline?: string },
  ): Promise<ScorecardTrend> {
    // Narrow at the SQL level by dataset (+optional harness)·succeeded — avoid a full workspace scan (suite defensively re-filters).
    const records = await this.deps.store.list(tenant, {
      dataset: opts.datasetId,
      status: "succeeded",
      kind: "scorecard", // experiments are ungraded (P1) — they never belong on a trend
      ...(opts.harnessId ? { harness: opts.harnessId } : {}),
    });
    return trendSeries(records, opts);
  }

  // Per-benchmark (dataset) leaderboard — group a dataset's scorecards by (harness × model) and rank by metric.
  // Computed from the list (lightweight summary+models) alone — no heavy traces needed. ScorecardRecord structurally satisfies LeaderboardCard.
  async leaderboard(
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
    // Narrow at the SQL level by dataset (+optional harness)·succeeded — summary-derived axes like model/judgeModel/window are filtered by suite.
    const records = await this.deps.store.list(tenant, {
      dataset: opts.datasetId,
      status: "succeeded",
      kind: "scorecard", // experiments are ungraded (P1) — they never rank
      ...(opts.harnessId ? { harness: opts.harnessId } : {}),
    });
    return leaderboard(records, opts);
  }

  // Flexible analysis pivot (filter/group/pivot/measure) over the workspace's scorecards — the server-side twin of
  // the web analyze dashboard, shared by the web (large workspaces) and the agent (query_scorecards).
  // Computed from the list (lightweight summary/models/origin) alone — ScorecardRecord structurally satisfies
  // AnalysisCard. Narrows dataset/harness at the SQL level when the filter pins exactly one (domain re-filters
  // defensively). docs/architecture/analysis-studio.md (V1).
  async analysis(tenant: string, config: AnalysisConfig): Promise<AnalysisResult> {
    const f = config.filters;
    const dataset = f.dataset?.length === 1 ? f.dataset[0] : undefined;
    const harness = f.harness?.length === 1 ? f.harness[0] : undefined;
    const records = await this.deps.store.list(tenant, {
      kind: "scorecard", // experiments are ungraded (P1) — score-less rows would only add noise to the pivot
      ...(dataset !== undefined ? { dataset } : {}),
      ...(harness !== undefined ? { harness } : {}),
    });
    return computeAnalysis(records, config);
  }

  // The offloaded analysis bundle (ScorecardRecord.analysisRef) read server-side — the per-case verdicts/scores
  // without re-reading every child run. A record with no ref at all reads 404 like a missing resource.
  //
  // The stored ref is NOT how we read it back: `put` returns a PRESIGNED url (it expires — an hour later the record's
  // ref answers 403) pointing at the SERVER-internal endpoint. So we read the artifact by its KEY through the store,
  // which is stable forever, and keep the ref fetch only as the fallback for an artifact this deployment's store does
  // not hold (a foreign bucket, or no store wired here). A fetch/parse failure is the upstream store's fault → UpstreamError.
  async analysisBundle(tenant: string, id: string): Promise<unknown> {
    const record = await this.getRecord(id);
    if (!record || record.tenant !== tenant)
      throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' not found.`);
    const ref = record.analysisRef;
    if (!ref) throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' has no downloadable analysis artifact.`);
    const fromStore = await this.readAnalysisArtifact(id);
    if (fromStore !== undefined) return fromStore;
    if (!/^https?:\/\//i.test(ref))
      throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' has no downloadable analysis artifact.`);
    try {
      const res = await fetch(ref);
      if (!res.ok)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { id, status: res.status },
          `analysis artifact fetch failed (${res.status}).`,
        );
      return (await res.json()) as unknown;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { id },
        `analysis artifact fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // The analysis artifact by KEY — the same key `offloadAnalysis` wrote (`analyses/<id>.json`). undefined = this
  // deployment's store doesn't hold it (no store wired, another bucket, unparseable bytes) → the caller falls back
  // to the ref. A store OUTAGE (as opposed to an absent object) propagates as the store's own UpstreamError.
  private async readAnalysisArtifact(id: string): Promise<unknown | undefined> {
    const bytes = await this.deps.artifacts?.get(analysisArtifactKey(id));
    if (!bytes) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      return undefined; // corrupt/partial object — let the ref path have its say rather than failing the read here
    }
  }

  // model-axis backfill — derive the observed model from the stored trace of (old) succeeded scorecards that lack models yet, and fill it in.
  // idempotent: skip if models already present. The trace is the source of truth, so observation only (no declared fallback). It's bulk, so get only what's needed.
  async backfillModels(tenant: string): Promise<{ scanned: number; updated: number }> {
    const records = await this.deps.store.list(tenant); // list includes models (lightweight) → can tell whether they already exist
    let updated = 0;
    for (const r of records) {
      if (r.models || r.status !== "succeeded") continue; // already filled, or no output
      const full = await this.deps.store.get(r.id); // the trace lives only inside the heavy scorecard
      if (!full?.scorecard) continue;
      await this.deps.store.update(r.id, { models: scorecardModels(full.scorecard), updatedAt: this.now() });
      updated += 1;
    }
    return { scanned: records.length, updated };
  }

  // Ensure workspace scope + completion (scorecard exists). 404 if missing (no existence leak), 400 if incomplete.
  private async requireSucceeded(tenant: string, id: string): Promise<Scorecard> {
    const record = await this.getRecord(id); // get hydrates dedup storage from child runs — diff works regardless of embed/reference
    if (!record || record.tenant !== tenant)
      throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' not found.`);
    if (!record.scorecard)
      throw new BadRequestError(
        "BAD_REQUEST",
        { id, status: record.status },
        `scorecard '${id}' is not complete yet (status=${record.status}).`,
      );
    return record.scorecard;
  }
}
