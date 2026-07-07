import type { CaseResult, Score, Scorecard } from "@everdict/core";

// 케이스 합격 판정 — 권위 기준 우선. ground-truth(실제 상태 검증) > 객관 대조 > 모델 의견 순으로 결정한다.
// VLM/LLM judge 는 *보조* 다: 객관/ground-truth 그레이더가 있으면 judge 가 그것을 뒤집지 못한다(예: OSWorld 파일저장 —
// state grader 가 파일을 확인했으면 judge 가 스크린샷만 보고 FAIL 해도 케이스는 PASS). 통합/스코어카드 통과율의 기준.
const AUTHORITATIVE_METRICS = ["state", "tests_pass"]; // 실제 상태/테스트 검증(ground-truth)
const OBJECTIVE_METRICS = ["answer_match", "url_matches", "dom_contains"]; // 결정적 대조
export function caseVerdict(result: Pick<CaseResult, "scores">): boolean | undefined {
  const byMetric = new Map(result.scores.map((s) => [s.metric, s] as const));
  for (const m of AUTHORITATIVE_METRICS) {
    const s = byMetric.get(m);
    if (s?.pass !== undefined) return s.pass; // ground-truth 가 있으면 그것이 권위
  }
  const objs = OBJECTIVE_METRICS.map((m) => byMetric.get(m)).filter((s): s is Score => s?.pass !== undefined);
  if (objs.length > 0) return objs.every((s) => s.pass); // 객관 그레이더(들)가 모두 pass
  const judge = byMetric.get("judge");
  if (judge?.pass !== undefined) return judge.pass; // 객관 그레이더가 없을 때만 judge 가 결정
  const withPass = result.scores.filter((s) => s.pass !== undefined);
  return withPass.length > 0 ? withPass.every((s) => s.pass) : undefined;
}

// 스코어카드의 케이스 단위 통과율(권위 기준 caseVerdict 로 집계). pass 판정 그레이더가 하나도 없는 케이스는 제외.
export function scorecardPassRate(sc: Scorecard): { pass: number; total: number; rate: number } {
  let pass = 0;
  let total = 0;
  for (const r of sc.results) {
    const v = caseVerdict(r);
    if (v === undefined) continue;
    total++;
    if (v) pass++;
  }
  return { pass, total, rate: total > 0 ? pass / total : 0 };
}

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
