import type { CaseResult, Score, Scorecard } from "@everdict/contracts";

// Case pass verdict — authority-first. Decided in the order ground-truth (real-state verification) > objective comparison > model opinion.
// The VLM/LLM judge is *auxiliary*: if an objective/ground-truth grader exists, the judge cannot override it (e.g. OSWorld file save —
// if the state grader confirmed the file, the case is PASS even if the judge FAILs it from the screenshot alone). The basis for the integrated/scorecard pass rate.
const AUTHORITATIVE_METRICS = ["state", "tests_pass"]; // real state/test verification (ground-truth)
const OBJECTIVE_METRICS = ["answer_match", "url_matches", "dom_contains"]; // deterministic comparison
export function caseVerdict(result: Pick<CaseResult, "scores">): boolean | undefined {
  const byMetric = new Map(result.scores.map((s) => [s.metric, s] as const));
  for (const m of AUTHORITATIVE_METRICS) {
    const s = byMetric.get(m);
    if (s?.pass !== undefined) return s.pass; // if ground-truth exists, it is authoritative
  }
  const objs = OBJECTIVE_METRICS.map((m) => byMetric.get(m)).filter((s): s is Score => s?.pass !== undefined);
  if (objs.length > 0) return objs.every((s) => s.pass); // all objective grader(s) pass
  const judge = byMetric.get("judge");
  if (judge?.pass !== undefined) return judge.pass; // the judge decides only when there is no objective grader
  const withPass = result.scores.filter((s) => s.pass !== undefined);
  return withPass.length > 0 ? withPass.every((s) => s.pass) : undefined;
}

// Per-case pass rate of a scorecard (aggregated via the authority-based caseVerdict). Cases with no pass-deciding grader are excluded.
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

// Per-metric aggregation (count/mean/pass rate).
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

// baseline(vA) vs candidate(vB). Regressions/improvements are decided by objective `pass` transitions —
// numeric metrics (cost/steps etc.) assume no direction and only report the delta.
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
