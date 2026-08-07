import {
  AppError,
  BadRequestError,
  NotFoundError,
  type Scorecard,
  type ScorecardRecord,
  UpstreamError,
  type VerdictPolicyRef,
} from "@everdict/contracts";
import {
  type AnalysisConfig,
  type AnalysisResult,
  type Leaderboard,
  type MeasurementCoverage,
  type ScorecardDiff,
  type ScorecardTrend,
  type TrialDiff,
  computeAnalysis,
  diffScorecards,
  diffTrials,
  flakeIndex,
  gateAudit,
  leaderboard,
  measurementCoverage,
  ownedByVisibleTeam,
  preferredMetric,
  scorecardModels,
  trendSeries,
  workspaceOpsReport,
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
    opts: { zThreshold?: number; minDelta?: number; visibleTeams?: string[] } = {},
  ): Promise<
    ScorecardDiff & {
      trials?: TrialDiff;
      policyMismatch?: { baseline: VerdictPolicyRef; candidate: VerdictPolicyRef };
      coverage: { baseline: MeasurementCoverage; candidate: MeasurementCoverage };
    }
  > {
    const { scorecard: baseline, record: baseRecord } = await this.requireSucceeded(
      tenant,
      baselineId,
      opts.visibleTeams,
    );
    const { scorecard: candidate, record: candRecord } = await this.requireSucceeded(
      tenant,
      candidateId,
      opts.visibleTeams,
    );
    const diff = diffScorecards(baseline, candidate);
    // Two batches judged under different verdict-policy documents are not the same experiment: their verdicts
    // (and therefore pass transitions) were produced by different rules. The comparison is flagged as NOT
    // holding — "no differences" and "incomparable" are different claims. Absent stamps (pre-mig records)
    // resolve to the default ladder, so only a REAL digest divergence trips this.
    const bPolicy = baseRecord.verdictPolicy;
    const cPolicy = candRecord.verdictPolicy;
    const policyMismatch = bPolicy !== undefined && cPolicy !== undefined && bPolicy.digest !== cPolicy.digest;
    const withPolicy: ScorecardDiff & { policyMismatch?: { baseline: VerdictPolicyRef; candidate: VerdictPolicyRef } } =
      policyMismatch && bPolicy && cPolicy
        ? { ...diff, comparability: "none", policyMismatch: { baseline: bPolicy, candidate: cPolicy } }
        : diff;
    const hasTrials =
      baseline.results.some((r) => r.trial !== undefined) || candidate.results.some((r) => r.trial !== undefined);
    // Evidence quality of each side. Aggregates already drop unmeasured scores, so a hollowed-out batch reads
    // as healthy — the ratio has to travel WITH the comparison for a gate to be able to refuse on it.
    const coverage = { baseline: measurementCoverage(baseline), candidate: measurementCoverage(candidate) };
    return hasTrials
      ? { ...withPolicy, coverage, trials: diffTrials(baseline, candidate, opts) }
      : { ...withPolicy, coverage };
  }

  // Workspace ops report (metrics commercialization C1) — the SLA-evidence read: the workspace's OWN
  // execution health over a window, the platform's failure share separated from the product's. The numbers
  // are the domain's (workspaceOpsReport) — this method only hydrates the ledger rows (per-case detail lives
  // on the children, so each in-range record goes through the facade's hydrating get).
  async opsReport(
    tenant: string,
    opts: { from?: string; to?: string; visibleTeams?: string[] },
  ): Promise<ReturnType<typeof workspaceOpsReport>> {
    const rows = await this.deps.store.list(tenant, {
      ...(opts.visibleTeams ? { visibleTeams: opts.visibleTeams } : {}),
    });
    const inRange = rows.filter(
      (r) => (opts.from === undefined || r.createdAt >= opts.from) && (opts.to === undefined || r.createdAt <= opts.to),
    );
    const detailed: ScorecardRecord[] = [];
    for (const row of inRange) {
      const record = await this.getRecord(row.id);
      if (record) detailed.push(record);
    }
    return workspaceOpsReport(detailed, {
      ...(opts.from ? { from: opts.from } : {}),
      ...(opts.to ? { to: opts.to } : {}),
    });
  }

  // A2 (catalog T3/T9) — the cross-batch flake index for a dataset: same (case, harness@version, runtime)
  // key across succeeded batches, verdicts derived under each batch's OWN stamped policy. Detail hydration
  // through the facade's get (verdicts need per-case results).
  async flake(
    tenant: string,
    opts: { datasetId: string; harnessId?: string; visibleTeams?: string[] },
  ): Promise<ReturnType<typeof flakeIndex>> {
    const rows = await this.deps.store.list(tenant, {
      dataset: opts.datasetId,
      status: "succeeded",
      kind: "scorecard",
      ...(opts.harnessId ? { harness: opts.harnessId } : {}),
      ...(opts.visibleTeams ? { visibleTeams: opts.visibleTeams } : {}),
    });
    const detailed: ScorecardRecord[] = [];
    for (const row of rows) {
      const record = await this.getRecord(row.id);
      if (record) detailed.push(record);
    }
    return flakeIndex(detailed);
  }

  // B2 — the governance window over the ledger's recorded gate decisions. The numbers are the domain's
  // (gateAudit); the list rows carry the (small) gates arrays, so no detail hydration is needed.
  async gateAudit(
    tenant: string,
    opts: { from?: string; to?: string; visibleTeams?: string[] },
  ): Promise<ReturnType<typeof gateAudit>> {
    const rows = await this.deps.store.list(tenant, {
      ...(opts.visibleTeams ? { visibleTeams: opts.visibleTeams } : {}),
    });
    return gateAudit(rows, {
      ...(opts.from !== undefined ? { from: opts.from } : {}),
      ...(opts.to !== undefined ? { to: opts.to } : {}),
    });
  }

  // Time-range trend / regression-over-time — line up a (dataset, metric)'s scorecards chronologically and flag regressions vs the baseline.
  // Computed from the list (lightweight summary) alone — no heavy traces needed. ScorecardRecord structurally satisfies TrendCard.
  async trend(
    tenant: string,
    opts: {
      datasetId: string;
      metric?: string; // absent = preferredMetric over the dataset's cards (see leaderboard)
      harnessId?: string;
      from?: string;
      to?: string;
      baseline?: string;
      // The caller's ownership ceiling (undefined = none). A trend is a shape derived from batches, so a batch the
      // caller cannot see must not bend the line either.
      visibleTeams?: string[];
    },
  ): Promise<ScorecardTrend> {
    // Narrow at the SQL level by dataset (+optional harness)·succeeded — avoid a full workspace scan (suite defensively re-filters).
    const records = await this.deps.store.list(tenant, {
      dataset: opts.datasetId,
      status: "succeeded",
      kind: "scorecard", // experiments are ungraded (P1) — they never belong on a trend
      ...(opts.harnessId ? { harness: opts.harnessId } : {}),
      ...(opts.visibleTeams ? { visibleTeams: opts.visibleTeams } : {}),
    });
    const metric = opts.metric ?? preferredMetric(records) ?? "tests_pass";
    return trendSeries(records, { ...opts, metric });
  }

  // Per-benchmark (dataset) leaderboard — group a dataset's scorecards by (harness × model) and rank by metric.
  // Computed from the list (lightweight summary+models) alone — no heavy traces needed. ScorecardRecord structurally satisfies LeaderboardCard.
  async leaderboard(
    tenant: string,
    opts: {
      datasetId: string;
      // Absent = resolved from the data (preferredMetric — the highest-authority pass-rate metric present).
      // A literal default ("judge"/"tests_pass") gave a silently empty board to any workspace whose graders
      // summarize under other names.
      metric?: string;
      harnessId?: string;
      model?: string;
      judgeModel?: string;
      window?: "latest" | "best";
      // The caller's ownership ceiling (undefined = none) — a ranking that counts rows the caller cannot open is
      // a leak dressed as an average.
      visibleTeams?: string[];
    },
  ): Promise<Leaderboard> {
    // Narrow at the SQL level by dataset (+optional harness)·succeeded — summary-derived axes like model/judgeModel/window are filtered by suite.
    const records = await this.deps.store.list(tenant, {
      dataset: opts.datasetId,
      status: "succeeded",
      kind: "scorecard", // experiments are ungraded (P1) — they never rank
      ...(opts.harnessId ? { harness: opts.harnessId } : {}),
      ...(opts.visibleTeams ? { visibleTeams: opts.visibleTeams } : {}),
    });
    const metric = opts.metric ?? preferredMetric(records) ?? "tests_pass"; // empty set: any name labels an empty board
    return leaderboard(records, { ...opts, metric });
  }

  // Flexible analysis pivot (filter/group/pivot/measure) over the workspace's scorecards — the server-side twin of
  // the web analyze dashboard, shared by the web (large workspaces) and the agent (query_scorecards).
  // Computed from the list (lightweight summary/models/origin) alone — ScorecardRecord structurally satisfies
  // AnalysisCard. Narrows dataset/harness at the SQL level when the filter pins exactly one (domain re-filters
  // defensively). docs/architecture/analysis-studio.md (V1).
  // `visibleTeams` is a separate parameter rather than a field on the config on purpose: the config is parsed from
  // the request body, and an ownership ceiling that a caller could type is not a ceiling.
  async analysis(tenant: string, config: AnalysisConfig, visibleTeams?: string[]): Promise<AnalysisResult> {
    const f = config.filters;
    const dataset = f.dataset?.length === 1 ? f.dataset[0] : undefined;
    const harness = f.harness?.length === 1 ? f.harness[0] : undefined;
    const records = await this.deps.store.list(tenant, {
      kind: "scorecard", // experiments are ungraded (P1) — score-less rows would only add noise to the pivot
      ...(dataset !== undefined ? { dataset } : {}),
      ...(harness !== undefined ? { harness } : {}),
      ...(visibleTeams ? { visibleTeams } : {}),
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
  async analysisBundle(tenant: string, id: string, visibleTeams?: string[]): Promise<unknown> {
    const record = await this.getRecord(id);
    if (!record || record.tenant !== tenant || !ownedByVisibleTeam(record, visibleTeams))
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

  // Ensure workspace scope + team scope + completion (scorecard exists). 404 if missing OR owned by a team the
  // caller cannot see (no existence leak — the same answer another workspace's id gets), 400 if incomplete.
  private async requireSucceeded(
    tenant: string,
    id: string,
    visibleTeams?: string[],
  ): Promise<{ scorecard: Scorecard; record: ScorecardRecord }> {
    const record = await this.getRecord(id); // get hydrates dedup storage from child runs — diff works regardless of embed/reference
    if (!record || record.tenant !== tenant || !ownedByVisibleTeam(record, visibleTeams))
      throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' not found.`);
    if (!record.scorecard)
      throw new BadRequestError(
        "BAD_REQUEST",
        { id, status: record.status },
        `scorecard '${id}' is not complete yet (status=${record.status}).`,
      );
    return { scorecard: record.scorecard, record };
  }
}
