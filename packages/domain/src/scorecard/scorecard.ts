import {
  type CaseResult,
  type Score,
  type Scorecard,
  type VerdictPolicy,
  isMeasured,
  measuredScores,
  metricMatches,
} from "@everdict/contracts";
import { DEFAULT_VERDICT_POLICY, evaluateVerdict } from "./verdict-policy.js";

export { PRE_OUTCOME_STAGES } from "./verdict-policy.js";

// Case pass verdict — authority-first. Decided in the order ground-truth (real-state verification) > objective comparison > model opinion.
// The VLM/LLM judge is *auxiliary*: if an objective/ground-truth grader exists, the judge cannot override it (e.g. OSWorld file save —
// if the state grader confirmed the file, the case is PASS even if the judge FAILs it from the screenshot alone). The basis for the integrated/scorecard pass rate.
// The ladder itself is DATA now (DEFAULT_VERDICT_POLICY in verdict-policy.ts, versioned + digested); this is
// the plain boolean view of evaluateVerdict — use evaluateVerdict directly when the basis (which rung decided,
// from which measurements) must ride along.
export function caseVerdict(
  result: Pick<CaseResult, "scores"> & Pick<Partial<CaseResult>, "failure">,
): boolean | undefined {
  return evaluateVerdict(result).verdict;
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
  // Categorical metrics (scores carrying `label`): the label distribution (ordered enum → ordinal order, else by
  // frequency) + the most-frequent label (mode). Set only when the metric is categorical; numeric/boolean metrics
  // leave them unset. Isomorphic to the contracts MetricSummarySchema. docs/architecture/eval-domain-model.md
  distribution?: { label: string; count: number }[];
  mode?: string;
  // Scores of this metric that were NOT measurements (grader error / skip) — excluded from every aggregate above
  // and tallied here so a grader outage is visible instead of dragging the mean toward 0. Set only when > 0.
  unmeasured?: number;
}

// Per-metric aggregation. Numeric/boolean metrics ⇒ count/mean/passRate. A CATEGORICAL metric (any score carried a
// `label`) additionally gets a label distribution + mode — averaging a tier/string is meaningless, so the display
// keys off the distribution instead of the mean (which stays populated as the mean of the ordering `value`).
// MEASUREMENTS ONLY: an unmeasured score (grader error, judge skip — isMeasured gate) never contributes a value,
// pass, or label; it only increments the metric's `unmeasured` tally.
export function summarizeScorecard(sc: Scorecard): MetricSummary[] {
  const byMetric = new Map<
    string,
    { values: number[]; passes: boolean[]; labeled: { label: string; value: number }[]; unmeasured: number }
  >();
  for (const result of sc.results) {
    for (const s of result.scores) {
      const m = byMetric.get(s.metric) ?? { values: [], passes: [], labeled: [], unmeasured: 0 };
      byMetric.set(s.metric, m);
      if (!isMeasured(s)) {
        m.unmeasured++;
        continue;
      }
      m.values.push(s.value);
      if (s.pass !== undefined) m.passes.push(s.pass);
      // Pair the label with its ordering `value` (not the metric-wide values[], which would misalign if some scores
      // in the metric lacked a label) so an ORDERED enum can be shown in its natural order.
      if (s.label !== undefined) m.labeled.push({ label: s.label, value: s.value });
    }
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...byMetric.entries()].map(([metric, m]) => {
    const summary: MetricSummary = {
      metric,
      count: m.values.length,
      mean: m.values.reduce((a, b) => a + b, 0) / (m.values.length || 1),
      passRate: m.passes.length > 0 ? m.passes.filter(Boolean).length / m.passes.length : undefined,
      ...(m.unmeasured > 0 ? { unmeasured: m.unmeasured } : {}),
    };
    if (m.labeled.length > 0) {
      const counts = new Map<string, number>();
      const ordinal = new Map<string, number>(); // label → its ordering value (first seen); 0 for an unordered enum
      for (const { label, value } of m.labeled) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
        if (!ordinal.has(label)) ordinal.set(label, value);
      }
      const ord = (l: string) => ordinal.get(l) ?? 0;
      // Display order: ordering `value` ascending (bronze<silver<gold), then most-frequent, then label — so an ORDERED
      // enum reads in its natural order, while an UNORDERED one (every value 0) falls back to frequency. Deterministic.
      summary.distribution = [...counts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => ord(a.label) - ord(b.label) || b.count - a.count || cmp(a.label, b.label));
      // Mode = the single most-frequent label, independent of display order (ties → lower ordinal, then label).
      summary.mode = [...counts.entries()].sort(
        (a, b) => b[1] - a[1] || ord(a[0]) - ord(b[0]) || cmp(a[0], b[0]),
      )[0]?.[0];
    }
    return summary;
  });
}

export interface CaseDelta {
  caseId: string;
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  passChange?: "fixed" | "broke";
}
export interface MetricDelta {
  metric: string;
  baselineMean: number;
  candidateMean: number;
  delta: number;
  // Declared reading direction (verdict policy) + the delta interpreted THROUGH it. Without a declared
  // direction the reading is "unknown" — `delta > 0` must never be generalized as improvement (cost went up).
  direction?: "higher_is_better" | "lower_is_better" | "neutral";
  reading: "improved" | "regressed" | "unchanged" | "unknown";
}
// What could NOT be compared — a first-class output, never a silent skip or a zero-fill. A candidate whose
// grader vanished must read as "this metric became incomparable", not as a mean that fell to 0.
export interface DiffMissing {
  casesOnlyInBaseline: string[];
  casesOnlyInCandidate: string[];
  metricsOnlyInBaseline: string[];
  metricsOnlyInCandidate: string[];
}
export interface ScorecardDiff {
  baseline: string;
  candidate: string;
  metrics: MetricDelta[]; // metrics present on BOTH sides only — one-sided metrics are in `missing`
  regressions: CaseDelta[];
  improvements: CaseDelta[];
  missing: DiffMissing;
  // A metric present on both sides whose VALUE KIND changed (categorical on one side, numeric on the other —
  // same name, different meaning): its delta is not a number anyone should read. Excluded from `metrics`.
  incomparable: Array<{ metric: string; reason: "kind_changed" }>;
  // The raw overlap the comparability level was judged from — a gate that wants a threshold reads the numbers.
  overlap: { sharedCases: number; baselineCases: number; candidateCases: number };
  // "none" = the comparison does not hold (no shared cases or no shared metrics) — which is a different claim
  // from "no differences". A gate must read this FIRST.
  comparability: "full" | "partial" | "none";
}

// Keyed by (caseId, trial) — NOT caseId alone: on a trials>1 scorecard a caseId-keyed map silently kept the
// LAST trial's scores (map last-wins), so pass transitions compared arbitrary trials. Trial i pairs with
// trial i; the trial-statistical gate (diffTrials) remains the authoritative regression signal for trial runs.
function scoreMap(sc: Scorecard): Map<string, { caseId: string; metrics: Map<string, Score> }> {
  const m = new Map<string, { caseId: string; metrics: Map<string, Score> }>();
  for (const result of sc.results) {
    const key = `${result.caseId}#${result.trial ?? 0}`;
    const entry = m.get(key) ?? { caseId: result.caseId, metrics: new Map<string, Score>() };
    // Measurements only — a diff between an unmeasured placeholder and a real value is not a delta.
    for (const s of measuredScores(result.scores)) entry.metrics.set(s.metric, s);
    m.set(key, entry);
  }
  return m;
}

// The re-score worklist: unmeasured scores whose failure was transient (retryable) — re-running JUST these
// graders can recover the measurements without re-running any case. Feeds the targeted re-score path.
export interface RetryableUnmeasured {
  caseId: string;
  trial?: number;
  graderId: string;
  metric: string;
}
export function retryableUnmeasured(sc: Pick<Scorecard, "results">): RetryableUnmeasured[] {
  const out: RetryableUnmeasured[] = [];
  for (const r of sc.results) {
    for (const s of r.scores) {
      if (s.status === "unmeasured" && s.retryable === true) {
        out.push({
          caseId: r.caseId,
          ...(r.trial !== undefined ? { trial: r.trial } : {}),
          graderId: s.graderId,
          metric: s.metric,
        });
      }
    }
  }
  return out;
}

// Declared reading direction of a metric (verdict-policy MetricDefinition), interpreted onto a delta.
function metricReading(
  policy: VerdictPolicy,
  metric: string,
  delta: number,
): Pick<MetricDelta, "direction" | "reading"> {
  const direction = policy.metrics.find((d) => metricMatches(d.match, metric))?.direction;
  if (delta === 0) return { ...(direction ? { direction } : {}), reading: "unchanged" };
  if (direction === "higher_is_better") return { direction, reading: delta > 0 ? "improved" : "regressed" };
  if (direction === "lower_is_better") return { direction, reading: delta < 0 ? "improved" : "regressed" };
  return { ...(direction ? { direction } : {}), reading: "unknown" };
}

// baseline(vA) vs candidate(vB). Regressions/improvements are decided by objective `pass` transitions; numeric
// deltas are interpreted through the policy's declared directions (no direction ⇒ "unknown", never a sign
// guess). Missingness is an OUTPUT: one-sided cases/metrics are enumerated, aggregate means are computed only
// over both-sided metrics (the old `?? 0` fill made a vanished grader read as a mean that crashed to zero,
// while the case-level loop silently skipped the very same absence), and `comparability` says whether the
// comparison holds at all.
export function diffScorecards(
  baseline: Scorecard,
  candidate: Scorecard,
  opts: { policy?: VerdictPolicy } = {},
): ScorecardDiff {
  const policy = opts.policy ?? DEFAULT_VERDICT_POLICY;
  const b = scoreMap(baseline);
  const c = scoreMap(candidate);
  const regressions: CaseDelta[] = [];
  const improvements: CaseDelta[] = [];
  for (const [key, cEntry] of c) {
    const bEntry = b.get(key);
    if (!bEntry) continue; // enumerated below as casesOnlyInCandidate — never silently gone
    const caseId = cEntry.caseId;
    for (const [metric, cs] of cEntry.metrics) {
      const bs = bEntry.metrics.get(metric);
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
  const bCases = new Set(baseline.results.map((r) => r.caseId));
  const cCases = new Set(candidate.results.map((r) => r.caseId));
  const sumB = summarizeScorecard(baseline);
  const sumC = summarizeScorecard(candidate);
  const bMetricNames = new Set(sumB.filter((s) => s.count > 0).map((s) => s.metric));
  const cMetricNames = new Set(sumC.filter((s) => s.count > 0).map((s) => s.metric));
  const sharedNames = [...bMetricNames].filter((m) => cMetricNames.has(m));
  // Same name, different KIND (categorical on one side, numeric on the other — the distribution marks a
  // categorical summary): the delta of a tier against a mean is not a number anyone should read.
  const isCategorical = (rows: MetricSummary[], metric: string): boolean =>
    rows.find((s) => s.metric === metric)?.distribution !== undefined;
  const incomparable = sharedNames
    .filter((metric) => isCategorical(sumB, metric) !== isCategorical(sumC, metric))
    .map((metric) => ({ metric, reason: "kind_changed" as const }));
  const kindChanged = new Set(incomparable.map((x) => x.metric));
  const shared = sharedNames.filter((m) => !kindChanged.has(m));
  const metrics: MetricDelta[] = shared.map((metric) => {
    const baselineMean = sumB.find((s) => s.metric === metric)?.mean ?? 0; // guarded: metric ∈ both summaries
    const candidateMean = sumC.find((s) => s.metric === metric)?.mean ?? 0;
    const delta = candidateMean - baselineMean;
    return { metric, baselineMean, candidateMean, delta, ...metricReading(policy, metric, delta) };
  });
  const missing: DiffMissing = {
    casesOnlyInBaseline: [...bCases].filter((id) => !cCases.has(id)),
    casesOnlyInCandidate: [...cCases].filter((id) => !bCases.has(id)),
    metricsOnlyInBaseline: [...bMetricNames].filter((m) => !cMetricNames.has(m)),
    metricsOnlyInCandidate: [...cMetricNames].filter((m) => !bMetricNames.has(m)),
  };
  const sharedCases = [...bCases].filter((id) => cCases.has(id)).length;
  const anyMissing =
    missing.casesOnlyInBaseline.length > 0 ||
    missing.casesOnlyInCandidate.length > 0 ||
    missing.metricsOnlyInBaseline.length > 0 ||
    missing.metricsOnlyInCandidate.length > 0 ||
    incomparable.length > 0;
  const comparability = sharedCases === 0 || shared.length === 0 ? "none" : anyMissing ? "partial" : "full";
  return {
    baseline: baseline.harness,
    candidate: candidate.harness,
    metrics,
    regressions,
    improvements,
    missing,
    incomparable,
    overlap: { sharedCases, baselineCases: bCases.size, candidateCases: cCases.size },
    comparability,
  };
}
