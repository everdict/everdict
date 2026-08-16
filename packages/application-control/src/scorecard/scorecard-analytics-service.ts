import {
  AppError,
  BadRequestError,
  type CaseMatcher,
  ConflictError,
  type GateScoringPin,
  NotFoundError,
  type Scorecard,
  type ScorecardRecord,
  UpstreamError,
  type VerdictPolicyRef,
} from "@everdict/contracts";
import {
  type AnalysisConfig,
  type AnalysisResult,
  DEFAULT_VERDICT_POLICY,
  type ExperimentIdentity,
  type Leaderboard,
  type MeasurementCoverage,
  type PolicyResolution,
  type ScorecardDiff,
  type ScorecardTrend,
  type TrialDiff,
  computeAnalysis,
  contentDigest,
  currentScoringPin,
  diffScorecards,
  diffTrials,
  experimentIdentity,
  flakeIndex,
  gateAudit,
  leaderboard,
  measurementCoverage,
  ownedByVisibleTeam,
  preferredMetric,
  resolvePolicyResolution,
  scorecardModels,
  trendSeries,
  verdictPolicyRef,
  workspaceOpsReport,
} from "@everdict/domain";
import { ExecutionPlan } from "../scorecard/execution-plan.js";
import type { ScorecardAnalyticsDeps } from "./scorecard-deps.js";
import { analysisArtifactKey, analysisRevisionKey } from "./scorecard-observability.js";

// The unrestorable stamp(s) of a comparison, or undefined when both sides resolved. A stamped ref always
// carries its digest (VerdictPolicyRef), so an unresolvable side can always name what was looked for.
function unresolvableStamps(
  baseline: PolicyResolution,
  candidate: PolicyResolution,
): { baseline?: VerdictPolicyRef; candidate?: VerdictPolicyRef } | undefined {
  const named = (r: PolicyResolution): VerdictPolicyRef | undefined =>
    r.status === "unresolvable" && r.ref.digest !== undefined
      ? { id: r.ref.id, version: r.ref.version, digest: r.ref.digest }
      : undefined;
  if (baseline.status !== "unresolvable" && candidate.status !== "unresolvable") return undefined;
  const b = named(baseline);
  const c = named(candidate);
  return { ...(b ? { baseline: b } : {}), ...(c ? { candidate: c } : {}) };
}

// Analytics collaborator behind the ScorecardService facade (docs/architecture/api-route-modularization.md R2-b):
// read-side derivations over the store + the pure @everdict/domain aggregations — diff / trend / leaderboard /
// backfillModels. Composed only by the facade, which injects BOTH of its hydrating reads (child-run references
// → embedded scorecard): getRecord = display, getDecisionRecord = decision. See the fields below.
// The diff result the wire has always served — extracted so diff() and diffSnapshot() share one shape.
export type ScorecardDiffResult = ScorecardDiff & {
  trials?: TrialDiff;
  policyMismatch?: { baseline: VerdictPolicyRef; candidate: VerdictPolicyRef };
  policyUnresolvable?: { baseline?: VerdictPolicyRef; candidate?: VerdictPolicyRef };
  coverage: { baseline: MeasurementCoverage; candidate: MeasurementCoverage };
  criticalCases?: CaseMatcher[];
};

// One side of a comparison snapshot: the record the diff actually read, with its scoring pin AT THAT read.
export interface ComparisonSide {
  record: ScorecardRecord;
  pin?: { revision: number; scorePlaneDigest: string };
}
export interface ComparisonSnapshot {
  diff: ScorecardDiffResult;
  baseline: ComparisonSide;
  candidate: ComparisonSide;
}

function snapshotOf(
  diff: ScorecardDiffResult,
  baseRecord: ScorecardRecord,
  candRecord: ScorecardRecord,
): ComparisonSnapshot {
  const side = (record: ScorecardRecord): ComparisonSide => {
    const pin = currentScoringPin(record.scoring);
    return { record, ...(pin !== undefined ? { pin } : {}) };
  };
  return { diff, baseline: side(baseRecord), candidate: side(candRecord) };
}

export class ScorecardAnalyticsService {
  private readonly now: () => string;
  // The DISPLAY hydration (the facade's get) — what a viewer is shown, receipt-less cases included. Used by
  // the read-side surfaces that describe a batch: opsReport, flake, analysisBundle.
  private readonly getRecord: (id: string) => Promise<ScorecardRecord | undefined>;
  // The DECISION hydration (the facade's getForDecision) — a receipted batch's ledger alone. Used ONLY by
  // requireSucceeded, and therefore by diff / diffSnapshot and everything that gates on them.
  private readonly getDecisionRecord: (id: string) => Promise<ScorecardRecord | undefined>;

  constructor(
    private readonly deps: ScorecardAnalyticsDeps,
    shared: {
      now: () => string;
      getRecord: (id: string) => Promise<ScorecardRecord | undefined>;
      getDecisionRecord: (id: string) => Promise<ScorecardRecord | undefined>;
    },
  ) {
    this.now = shared.now;
    this.getRecord = shared.getRecord;
    this.getDecisionRecord = shared.getDecisionRecord;
  }

  // baseline vs candidate comparison — metric deltas over the same cases + pass transitions (regression/improvement). Both must be owned by this workspace and complete.
  // When either side ran repeated trials, the pass-transition regressions above are last-trial-noisy — attach the
  // statistically-gated trial diff (two-proportion z-test) as the authoritative regression signal. docs/architecture/trial-based-verdict.md
  async diff(
    tenant: string,
    baselineId: string,
    candidateId: string,
    opts: { zThreshold?: number; minDelta?: number; fdrAlpha?: number; visibleTeams?: string[] } = {},
  ): Promise<ScorecardDiffResult> {
    return (await this.diffSnapshot(tenant, baselineId, candidateId, opts)).diff;
  }

  // The COMPARISON SNAPSHOT (arch-review 7 P0, I4): the diff plus the exact records — and their scoring
  // pins — it was computed from, captured at the ONE read per side. The gate used to compute the diff and
  // then REFETCH both records for its pins: a re-score landing between the two reads stamped the decision
  // with a revision that did not produce the numbers it decided on (a classic TOCTOU, in either direction).
  // A decision must pin what it READ, not what was current when it got around to writing.
  async diffSnapshot(
    tenant: string,
    baselineId: string,
    candidateId: string,
    opts: { zThreshold?: number; minDelta?: number; fdrAlpha?: number; visibleTeams?: string[] } = {},
  ): Promise<ComparisonSnapshot> {
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
    // Each side is read under ITS OWN stamped policy. A stamp that cannot be restored is the one case that
    // must not fall through to the default ladder: the comparison would then stand on verdicts re-derived
    // under rules that batch never ran under, which is exactly what a release gate would act on.
    const bResolution = resolvePolicyResolution(baseRecord.verdictPolicy, ExecutionPlan.of(baseRecord).verdictPolicy);
    const cResolution = resolvePolicyResolution(candRecord.verdictPolicy, ExecutionPlan.of(candRecord).verdictPolicy);
    const policyUnresolvable = unresolvableStamps(bResolution, cResolution);
    // Metric DIRECTIONS (cost down = better) are read off a policy too. They are cosmetic here — they colour
    // deltas, they decide nothing — so an unrestorable stamp falls back to the built-in directions rather
    // than blanking the table; the comparison itself is already marked as not holding just below.
    const directionPolicy =
      cResolution.status === "unresolvable"
        ? bResolution.status === "unresolvable"
          ? DEFAULT_VERDICT_POLICY
          : bResolution.policy
        : cResolution.policy;
    // Case transitions (the gate's regression unit) are judged under each side's OWN resolved policy. An
    // unresolvable side is passed EXPLICITLY — omitting it made diffScorecards fall back to the other side's
    // ladder and re-judge verdicts the batch never produced (the transitions then leaked into gate evidence).
    const diff = diffScorecards(baseline, candidate, {
      policy: directionPolicy,
      baselinePolicy: bResolution.status !== "unresolvable" ? bResolution.policy : "unresolvable",
      candidatePolicy: cResolution.status !== "unresolvable" ? cResolution.policy : "unresolvable",
    });
    // Two batches judged under different verdict-policy DOCUMENTS are not the same experiment: their verdicts
    // (and therefore pass transitions) were produced by different rules. The comparison is flagged as NOT
    // holding — "no differences" and "incomparable" are different claims. The mismatch is decided on the
    // RESOLVED documents' canonical identity, never on raw stamp strings: a legacy-FNV stamp and a sha256
    // stamp of the SAME canonical document are one policy (the resolver dual-reads both eras — comparing the
    // strings re-introduced the split it exists to bridge), and an unstamped pre-mig record compares as the
    // frozen v1 ladder it was judged under.
    const bothResolved = bResolution.status !== "unresolvable" && cResolution.status !== "unresolvable";
    const policyMismatch = bothResolved && contentDigest(bResolution.policy) !== contentDigest(cResolution.policy);
    // The refusal names each side by its own stamp when it has one, else by the resolved document's ref —
    // an unstamped side still judged under a nameable rule-set.
    const stampOf = (record: ScorecardRecord, resolution: PolicyResolution): VerdictPolicyRef | undefined =>
      record.verdictPolicy ?? (resolution.status !== "unresolvable" ? verdictPolicyRef(resolution.policy) : undefined);
    const bStamp = stampOf(baseRecord, bResolution);
    const cStamp = stampOf(candRecord, cResolution);
    // The experiment-identity read (held / confounds / unverified) — the two manifests against each other,
    // so the gate can refuse a comparison whose held-constant axes verifiably differ (a different experiment)
    // and every consumer sees what the seals could and could not verify.
    const experiment = experimentIdentity(baseRecord.manifest, candRecord.manifest);
    const withPolicy: ScorecardDiff & {
      policyMismatch?: { baseline: VerdictPolicyRef; candidate: VerdictPolicyRef };
      policyUnresolvable?: { baseline?: VerdictPolicyRef; candidate?: VerdictPolicyRef };
      experiment: ExperimentIdentity;
    } = policyUnresolvable
      ? { ...diff, comparability: "none", policyUnresolvable, experiment }
      : policyMismatch && bStamp && cStamp
        ? { ...diff, comparability: "none", policyMismatch: { baseline: bStamp, candidate: cStamp }, experiment }
        : { ...diff, experiment };
    const hasTrials =
      baseline.results.some((r) => r.trial !== undefined) || candidate.results.some((r) => r.trial !== undefined);
    // Evidence quality of each side. Aggregates already drop unmeasured scores, so a hollowed-out batch reads
    // as healthy — the ratio has to travel WITH the comparison for a gate to be able to refuse on it.
    const coverage = { baseline: measurementCoverage(baseline), candidate: measurementCoverage(candidate) };
    // Criticality is read off the CANDIDATE's own resolved policy — it is the candidate that is asking to
    // ship. An unresolvable candidate stamp contributes none: the pair is already refused as not_comparable,
    // and inventing critical cases out of the default ladder would be the same retroactive rewrite.
    const criticalCases = cResolution.status !== "unresolvable" ? cResolution.policy.criticalCases : undefined;
    const withCritical = criticalCases !== undefined && criticalCases.length > 0 ? { criticalCases } : {};
    // An unresolvable stamp gets no statistical signal either: diffTrials would re-derive that side's pass
    // rates under a ladder the batch never ran — the same retroactive rewrite the transitions refuse.
    if (!hasTrials || policyUnresolvable)
      return snapshotOf({ ...withPolicy, coverage, ...withCritical }, baseRecord, candRecord);
    return snapshotOf(
      {
        ...withPolicy,
        coverage,
        ...withCritical,
        // Each side's trial pass rates are computed under its own resolved policy — the statistical regression
        // signal a gate reads must not be manufactured by re-judging one side.
        trials: diffTrials(baseline, candidate, {
          ...(opts.zThreshold !== undefined ? { zThreshold: opts.zThreshold } : {}),
          ...(opts.minDelta !== undefined ? { minDelta: opts.minDelta } : {}),
          ...(opts.fdrAlpha !== undefined ? { fdrAlpha: opts.fdrAlpha } : {}),
          ...(bResolution.status !== "unresolvable" ? { baselinePolicy: bResolution.policy } : {}),
          ...(cResolution.status !== "unresolvable" ? { candidatePolicy: cResolution.policy } : {}),
        }),
      },
      baseRecord,
      candRecord,
    );
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
  async analysisBundle(tenant: string, id: string, visibleTeams?: string[], revision?: number): Promise<unknown> {
    const record = await this.getRecord(id);
    if (!record || record.tenant !== tenant || !ownedByVisibleTeam(record, visibleTeams))
      throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' not found.`);
    // A specific scoring revision's FROZEN artifact (I7) — read by its immutable per-revision key; the
    // ledger entry's own ref is the only fallback. A revision without a frozen artifact (pre-I7 passes,
    // an offload that failed) reads 404 — the mutable current bundle is never served as history.
    if (revision !== undefined) {
      const entry = record.scoring?.find((rev) => rev.revision === revision);
      if (!entry)
        throw new NotFoundError(
          "NOT_FOUND",
          { id, revision },
          `scorecard '${id}' has no scoring revision ${revision}.`,
        );
      const fromRevisionStore = await this.readAnalysisArtifact(id, revision, entry.analysisKey);
      if (fromRevisionStore !== undefined) return fromRevisionStore;
      if (entry.analysisRef === undefined || !/^https?:\/\//i.test(entry.analysisRef))
        throw new NotFoundError(
          "NOT_FOUND",
          { id, revision },
          `scoring revision ${revision} of scorecard '${id}' has no frozen analysis artifact.`,
        );
      return await this.fetchAnalysisRef(id, entry.analysisRef);
    }
    const ref = record.analysisRef;
    if (!ref) throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' has no downloadable analysis artifact.`);
    // THE CURRENT ANALYSIS IS THE CURRENT REVISION'S, NOT THE ALIAS'S (arch-review 52, Wave 4). The mutable
    // `analyses/<id>.json` key used to be read first and was therefore the authority — which is precisely why
    // a finalizer that overwrote it before losing its settle could make a cancelled batch's analysis surface
    // describe a successful run. Since Wave 4 that key is a CACHE the publisher promotes AFTER the settle
    // commits; the authority is the ledger's own immutable, pass-scoped artifact, so the read follows the
    // latest scoring revision's `analysisKey` first and falls back to the alias for revisions written before
    // artifacts were pass-keyed.
    const current = record.scoring?.at(-1)?.analysisKey;
    const fromRevision = current !== undefined ? await this.readAnalysisArtifact(id, undefined, current) : undefined;
    if (fromRevision !== undefined) return fromRevision;
    const fromStore = await this.readAnalysisArtifact(id);
    if (fromStore !== undefined) return fromStore;
    if (!/^https?:\/\//i.test(ref))
      throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' has no downloadable analysis artifact.`);
    return await this.fetchAnalysisRef(id, ref);
  }

  private async fetchAnalysisRef(id: string, ref: string): Promise<unknown> {
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
  private async readAnalysisArtifact(id: string, revision?: number, key?: string): Promise<unknown | undefined> {
    // The entry's OWN key wins: artifacts are pass-scoped, so the revision number no longer names the object.
    // A revision written before that (no key) still resolves through the legacy derived key.
    const resolved = key ?? (revision === undefined ? analysisArtifactKey(id) : analysisRevisionKey(id, revision));
    const bytes = await this.deps.artifacts?.get(resolved);
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
    // The DECISION read (arch-review 47 P1-5), not the display one: a comparison is evidence for a gate, and
    // an unreceipted membership row inside a receipted batch is an attempt the batch never committed. It
    // renders on a detail screen because a viewer should see everything that ran; it must not move a delta.
    const record = await this.getDecisionRecord(id); // hydrates dedup storage from child runs — works regardless of embed/reference
    if (!record || record.tenant !== tenant || !ownedByVisibleTeam(record, visibleTeams))
      throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' not found.`);
    if (!record.scorecard)
      throw new BadRequestError(
        "BAD_REQUEST",
        { id, status: record.status },
        `scorecard '${id}' is not complete yet (status=${record.status}).`,
      );
    // …and it must have SUCCEEDED (arch-review 8 P1). The method's name always claimed this; the check did
    // not exist. A failed batch persists partial ScorecardOutcomeExtras, and a cancelled/superseded one keeps
    // a partial scorecard through settleAborted — so a record with enough payload to look complete could
    // enter a comparison and be weighed as evidence, while its status says the run never finished. Product
    // release filters by status at list time, which hid this from that path; the gate's own contract did not.
    if (record.status !== "succeeded")
      throw new BadRequestError(
        "BAD_REQUEST",
        { id, status: record.status },
        `scorecard '${id}' did not succeed (status=${record.status}) — a ${record.status} batch's partial results are not comparable evidence.`,
      );
    // The revision boundary (arch-review 7 P0): while a scoring pass is live the persisted plane belongs to
    // NO completed revision, and a failed/abandoned pass left it BROKEN (judgments stripped, aggregate still
    // advertising them) — a comparison over either is a number nobody has the right to derive. Refuse
    // loudly; the pass settling (or a takeover pass) is the way through.
    const pass = record.scoringPass ?? undefined;
    if (pass !== undefined)
      throw new ConflictError(
        "CONFLICT",
        { id, scoringPass: { status: pass.status, targetRevision: pass.targetRevision, startedAt: pass.startedAt } },
        pass.status === "failed"
          ? `scorecard '${id}' carries an ABANDONED scoring pass (revision ${pass.targetRevision} failed mid-plane) — its score plane is not readable evidence; re-score to settle it.`
          : `scorecard '${id}' has a scoring pass in flight (revision ${pass.targetRevision}) — its score plane is between revisions; retry after it settles.`,
      );
    return { scorecard: record.scorecard, record };
  }

  // ── THE PINS-ONLY PRE-READ (arch-review 51 P1) ─────────────────────────────────────────────────────
  //
  // What the gate asks BEFORE it computes anything: the two sides' current scoring pins, under the same
  // scope/status/boundary contract as `requireSucceeded` (a caller must not learn through the trust refusal
  // what the 404/400/409 would have hidden) — but WITHOUT the decision hydration, because the pins live on
  // the record row and the per-case planes are only needed if the comparison actually runs. The diff that
  // may follow re-reads atomically and re-checks trust on its own pins (I4 stays the authority); this read
  // exists so untrusted input refuses before any verdict arithmetic runs, not after.
  async comparisonPins(
    tenant: string,
    baselineId: string,
    candidateId: string,
    visibleTeams?: string[],
  ): Promise<{ baseline?: GateScoringPin; candidate?: GateScoringPin }> {
    const read = async (id: string): Promise<GateScoringPin | undefined> => {
      const record = await this.deps.store.get(id);
      if (!record || record.tenant !== tenant || !ownedByVisibleTeam(record, visibleTeams))
        throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' not found.`);
      if (record.status !== "succeeded")
        throw new BadRequestError(
          "BAD_REQUEST",
          { id, status: record.status },
          `scorecard '${id}' did not succeed (status=${record.status}) — a ${record.status} batch's partial results are not comparable evidence.`,
        );
      const pass = record.scoringPass ?? undefined;
      if (pass !== undefined)
        throw new ConflictError(
          "CONFLICT",
          { id, scoringPass: { status: pass.status, targetRevision: pass.targetRevision, startedAt: pass.startedAt } },
          pass.status === "failed"
            ? `scorecard '${id}' carries an ABANDONED scoring pass (revision ${pass.targetRevision} failed mid-plane) — its score plane is not readable evidence; re-score to settle it.`
            : `scorecard '${id}' has a scoring pass in flight (revision ${pass.targetRevision}) — its score plane is between revisions; retry after it settles.`,
        );
      return currentScoringPin(record.scoring);
    };
    const baseline = await read(baselineId);
    const candidate = await read(candidateId);
    return { ...(baseline !== undefined ? { baseline } : {}), ...(candidate !== undefined ? { candidate } : {}) };
  }
}
