import { BadRequestError, NotFoundError, type Scorecard, type ScorecardRecord } from "@everdict/contracts";
import {
  type Leaderboard,
  type ScorecardDiff,
  type ScorecardTrend,
  type TrialDiff,
  diffScorecards,
  diffTrials,
  leaderboard,
  scorecardModels,
  trendSeries,
} from "@everdict/domain";
import type { ScorecardServiceDeps } from "./scorecard-shared.js";

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
      ...(opts.harnessId ? { harness: opts.harnessId } : {}),
    });
    return leaderboard(records, opts);
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
