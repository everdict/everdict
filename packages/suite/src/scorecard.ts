import type { Score, Scorecard } from "@assay/core";

export interface MetricSummary {
  metric: string;
  count: number;
  mean: number;
  passRate?: number;
}

// 메트릭별 집계 (개수/평균/통과율).
export function summarizeScorecard(sc: Scorecard): MetricSummary[] {
  const byMetric = new Map<string, { values: number[]; passes: boolean[] }>();
  for (const result of sc.results) {
    for (const s of result.scores) {
      const m = byMetric.get(s.metric) ?? { values: [], passes: [] };
      m.values.push(s.value);
      if (s.pass !== undefined) m.passes.push(s.pass);
      byMetric.set(s.metric, m);
    }
  }
  return [...byMetric.entries()].map(([metric, m]) => ({
    metric,
    count: m.values.length,
    mean: m.values.reduce((a, b) => a + b, 0) / (m.values.length || 1),
    passRate: m.passes.length > 0 ? m.passes.filter(Boolean).length / m.passes.length : undefined,
  }));
}

export interface CaseDelta {
  caseId: string;
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  passChange?: "fixed" | "broke";
}
export interface ScorecardDiff {
  baseline: string;
  candidate: string;
  metrics: Array<{ metric: string; baselineMean: number; candidateMean: number; delta: number }>;
  regressions: CaseDelta[];
  improvements: CaseDelta[];
}

function scoreMap(sc: Scorecard): Map<string, Map<string, Score>> {
  const m = new Map<string, Map<string, Score>>();
  for (const result of sc.results) {
    const inner = m.get(result.caseId) ?? new Map<string, Score>();
    for (const s of result.scores) inner.set(s.metric, s);
    m.set(result.caseId, inner);
  }
  return m;
}

// baseline(vA) vs candidate(vB). 회귀/개선은 객관적인 `pass` 전이로 판정한다 —
// 수치 메트릭(cost/steps 등)은 방향을 가정하지 않고 delta 만 보고한다.
export function diffScorecards(baseline: Scorecard, candidate: Scorecard): ScorecardDiff {
  const b = scoreMap(baseline);
  const c = scoreMap(candidate);
  const regressions: CaseDelta[] = [];
  const improvements: CaseDelta[] = [];
  for (const [caseId, cMetrics] of c) {
    const bMetrics = b.get(caseId);
    if (!bMetrics) continue;
    for (const [metric, cs] of cMetrics) {
      const bs = bMetrics.get(metric);
      if (!bs) continue;
      const d: CaseDelta = { caseId, metric, baseline: bs.value, candidate: cs.value, delta: cs.value - bs.value };
      if (bs.pass === true && cs.pass === false) {
        d.passChange = "broke";
        regressions.push(d);
      } else if (bs.pass === false && cs.pass === true) {
        d.passChange = "fixed";
        improvements.push(d);
      }
    }
  }
  const sumB = summarizeScorecard(baseline);
  const sumC = summarizeScorecard(candidate);
  const metricNames = new Set([...sumB.map((s) => s.metric), ...sumC.map((s) => s.metric)]);
  const metrics = [...metricNames].map((metric) => {
    const baselineMean = sumB.find((s) => s.metric === metric)?.mean ?? 0;
    const candidateMean = sumC.find((s) => s.metric === metric)?.mean ?? 0;
    return { metric, baselineMean, candidateMean, delta: candidateMean - baselineMean };
  });
  return { baseline: baseline.harness, candidate: candidate.harness, metrics, regressions, improvements };
}
