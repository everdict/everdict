import type { MetricSummary } from "./scorecard.js";

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
}

export interface TrendPoint {
  scorecardId: string;
  harness: string; // "id@version"
  createdAt: string;
  mean: number | null;
  passRate: number | null;
  score: number | null; // passRate first (mean if absent) — the trend/regression decision key
  deltaVsBaseline: number | null; // score - baseline.score (only when both exist)
  regressed: boolean; // score dropped vs baseline (> epsilon)
}

export interface ScorecardTrend {
  dataset: string; // datasetId
  metric: string;
  baseline: string; // "first" | "previous" | <scorecardId> (as requested)
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
      const mean = m ? m.mean : null;
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

  const points: TrendPoint[] = scored.map((s, i) => {
    const baseScore =
      baseline === "previous"
        ? (scored
            .slice(0, i)
            .reverse()
            .find((p) => p.score !== null)?.score ?? null)
        : fixedBaselineScore;
    const delta = s.score !== null && baseScore !== null ? s.score - baseScore : null;
    return {
      scorecardId: s.card.id,
      harness: `${s.card.harness.id}@${s.card.harness.version}`,
      createdAt: s.card.createdAt,
      mean: s.mean,
      passRate: s.passRate,
      score: s.score,
      deltaVsBaseline: delta,
      regressed: delta !== null && delta < -EPS,
    };
  });

  return { dataset: opts.datasetId, metric: opts.metric, baseline, points };
}
