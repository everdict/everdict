import type { MetricSummary } from "./scorecard.js";

// 기간 트렌드 / 회귀-오버-타임 — 한 (dataset, metric) 의 스코어카드들을 시간순으로 늘어놓고 baseline 대비 변화·회귀를 본다.
// 입력은 스코어카드의 *경량* 형태(목록 summary 로 충분) — @everdict/db 의 ScorecardRecord 가 구조적으로 이걸 만족한다
// (suite 는 db 에 의존하지 않음). diffScorecards 가 2개 ad-hoc 비교라면, 이건 N개를 기간 위에 늘어놓은 시계열이다.
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
  score: number | null; // passRate 우선(없으면 mean) — 트렌드/회귀 판정 기준값
  deltaVsBaseline: number | null; // score - baseline.score (둘 다 있을 때만)
  regressed: boolean; // score 가 baseline 대비 하락(> epsilon)
}

export interface ScorecardTrend {
  dataset: string; // datasetId
  metric: string;
  baseline: string; // "first" | "previous" | <scorecardId> (요청 그대로)
  points: TrendPoint[]; // createdAt 오름차순
}

const EPS = 1e-9;

// baseline: "first"(첫 포인트, 기본) | "previous"(각 포인트의 직전) | <scorecardId>(지정 기준).
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

  // 고정 baseline 의 기준 score(첫 유효 포인트 / 지정 스코어카드). "previous" 는 포인트별로 직전을 본다.
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
