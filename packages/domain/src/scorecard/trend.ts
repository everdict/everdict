import { metricMatches } from "@everdict/contracts";
import type { MetricSummary } from "./scorecard.js";
import { DEFAULT_VERDICT_POLICY } from "./verdict-policy.js";

// Period trend / regression-over-time — lays out one (dataset, metric)'s scorecards in time order and views change/regression vs baseline.
// The input is the *lightweight* shape of a scorecard (list summary is enough) — @everdict/db's ScorecardRecord satisfies this structurally
// (suite does not depend on db). Where diffScorecards is a 2-item ad-hoc comparison, this is a time series of N items over a period.
export interface TrendCard {
  id: string;
  dataset: { id: string; version: string };
  harness: { id: string; version: string };
  status: string;
  createdAt: string; // ISO
  summary?: MetricSummary[];
  verdictPolicy?: { digest: string }; // which policy judged this batch (absent = the default ladder)
}

export interface TrendPoint {
  scorecardId: string;
  harness: string; // "id@version"
  createdAt: string;
  mean: number | null;
  passRate: number | null;
  score: number | null; // passRate first (mean if absent) — the trend/regression decision key
  deltaVsBaseline: number | null; // score - baseline.score (only when both exist)
  regressed: boolean; // moved AGAINST the series' direction vs baseline (> epsilon); always false when direction is unknown
  // TRUE when this point was judged under a DIFFERENT verdict policy than its baseline point — the two rates
  // were produced by different rules, so a drop between them is never flagged as a regression.
  policyDiffers?: boolean;
}

export interface ScorecardTrend {
  dataset: string; // datasetId
  metric: string;
  baseline: string; // "first" | "previous" | <scorecardId> (as requested)
  // The reading direction the regression flags were computed under: the policy-declared direction for the
  // metric, else higher_is_better when the series is pass-rate-based. Absent = unknown direction — no point
  // is flagged regressed, and a consumer must not color the delta by sign.
  direction?: "higher_is_better" | "lower_is_better";
  // TRUE when the series mixes batches judged under different verdict policies — one line drawn through two
  // rule-sets. Points are kept (never silently dropped); cross-policy regression flags are suppressed per point.
  policyMixed?: boolean;
  points: TrendPoint[]; // createdAt ascending
}

const EPS = 1e-9;

// baseline: "first" (first point, default) | "previous" (each point's predecessor) | <scorecardId> (specified reference).
export function trendSeries(
  cards: TrendCard[],
  opts: { datasetId: string; metric: string; harnessId?: string; from?: string; to?: string; baseline?: string },
): ScorecardTrend {
  const baseline = opts.baseline ?? "first";
  const scored = cards
    .filter((c) => c.status === "succeeded")
    .filter((c) => c.dataset.id === opts.datasetId)
    .filter((c) => !opts.harnessId || c.harness.id === opts.harnessId)
    .filter((c) => !opts.from || c.createdAt >= opts.from)
    .filter((c) => !opts.to || c.createdAt <= opts.to)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => {
      const m = c.summary?.find((s) => s.metric === opts.metric);
      const passRate = m?.passRate ?? null;
      // Annihilated metric (mean absent) → NO point value: an outage is a gap in the line, not a plunge to 0.
      const mean = m?.mean ?? null;
      const score = passRate ?? mean;
      return { card: c, mean, passRate, score };
    });

  // Reference score of a fixed baseline (first valid point / specified scorecard). "previous" looks at the predecessor per point.
  const fixedBaselineScore =
    baseline === "first"
      ? (scored.find((s) => s.score !== null)?.score ?? null)
      : baseline === "previous"
        ? null
        : (scored.find((s) => s.card.id === baseline)?.score ?? null);

  // Reading direction: declared in the verdict policy for this metric; else, a pass-rate series is
  // higher-is-better by definition. A mean-based series with no declared direction has NO direction — a drop
  // in cost_usd was flagged "regressed" here (sign-as-verdict, the compare-page defect's trend twin).
  const declared = DEFAULT_VERDICT_POLICY.metrics.find((d) => metricMatches(d.match, opts.metric))?.direction;
  const usesPassRate = scored.some((s) => s.passRate !== null);
  const direction: "higher_is_better" | "lower_is_better" | undefined =
    declared === "higher_is_better" || declared === "lower_is_better"
      ? declared
      : usesPassRate
        ? "higher_is_better"
        : undefined;

  const digestOf = (card: TrendCard): string => card.verdictPolicy?.digest ?? "default";
  const baselineDigest =
    baseline === "first"
      ? (scored.find((s) => s.score !== null)?.card ?? scored[0]?.card)
      : baseline === "previous"
        ? undefined
        : scored.find((s) => s.card.id === baseline)?.card;
  const policyMixed = new Set(scored.map((s) => digestOf(s.card))).size > 1;

  const points: TrendPoint[] = scored.map((s, i) => {
    const prev =
      baseline === "previous"
        ? scored
            .slice(0, i)
            .reverse()
            .find((p) => p.score !== null)
        : undefined;
    const baseScore = baseline === "previous" ? (prev?.score ?? null) : fixedBaselineScore;
    const delta = s.score !== null && baseScore !== null ? s.score - baseScore : null;
    // Cross-policy comparison never regresses: the two rates were produced by different rules.
    const refCard = baseline === "previous" ? prev?.card : baselineDigest;
    const policyDiffers = refCard !== undefined && digestOf(refCard) !== digestOf(s.card);
    return {
      scorecardId: s.card.id,
      harness: `${s.card.harness.id}@${s.card.harness.version}`,
      createdAt: s.card.createdAt,
      mean: s.mean,
      passRate: s.passRate,
      score: s.score,
      deltaVsBaseline: delta,
      regressed:
        !policyDiffers &&
        delta !== null &&
        (direction === "higher_is_better" ? delta < -EPS : direction === "lower_is_better" ? delta > EPS : false),
      ...(policyDiffers ? { policyDiffers } : {}),
    };
  });

  return {
    dataset: opts.datasetId,
    metric: opts.metric,
    baseline,
    ...(direction ? { direction } : {}),
    ...(policyMixed ? { policyMixed } : {}),
    points,
  };
}
