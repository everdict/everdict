import {
  type CaseResult,
  type MeasuredScore,
  type Scorecard,
  type VerdictPolicy,
  isMeasured,
  measuredScores,
  metricMatches,
} from "@everdict/contracts";
import { DEFAULT_VERDICT_POLICY, PRE_OUTCOME_STAGES, evaluateVerdict } from "./verdict-policy.js";

export { PRE_OUTCOME_STAGES } from "./verdict-policy.js";

// Case pass verdict — authority-first. Decided in the order ground-truth (real-state verification) > objective comparison > model opinion.
// The VLM/LLM judge is *auxiliary*: if an objective/ground-truth grader exists, the judge cannot override it (e.g. OSWorld file save —
// if the state grader confirmed the file, the case is PASS even if the judge FAILs it from the screenshot alone). The basis for the integrated/scorecard pass rate.
// The ladder itself is DATA now (DEFAULT_VERDICT_POLICY in verdict-policy.ts, versioned + digested); this is
// the plain boolean view of evaluateVerdict — use evaluateVerdict directly when the basis (which rung decided,
// from which measurements) must ride along.
// The `policy` argument is the batch's OWN policy — a caller holding a stamped record MUST resolve it
// (resolvePolicyResolution) and pass it, or the verdict is re-derived under today's ladder. The default is for
// callers whose subject genuinely has no stamp (a single RunRecord, a live case mid-batch under the composed
// document in hand), never a licence to skip the resolution.
export function caseVerdict(
  result: Pick<CaseResult, "scores"> & Pick<Partial<CaseResult>, "failure">,
  policy: VerdictPolicy = DEFAULT_VERDICT_POLICY,
): boolean | undefined {
  return evaluateVerdict(result, policy).verdict;
}

// Per-case pass rate of a scorecard (aggregated via the authority-based caseVerdict). Cases with no pass-deciding grader are excluded.
export function scorecardPassRate(
  sc: Scorecard,
  policy: VerdictPolicy = DEFAULT_VERDICT_POLICY,
): { pass: number; total: number; rate: number } {
  let pass = 0;
  let total = 0;
  for (const r of sc.results) {
    const v = caseVerdict(r, policy);
    if (v === undefined) continue;
    total++;
    if (v) pass++;
  }
  return { pass, total, rate: total > 0 ? pass / total : 0 };
}

export interface MetricSummary {
  metric: string;
  count: number;
  // Absent when count is 0 (annihilated metric) — a mean over nothing is not 0.
  mean?: number;
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
// OUTCOMES ONLY: a case that never legitimately produced an outcome — cancelled at any stage, or dead before
// one (dispatch/install/run) — contributes NOTHING here, measured or not. Its story lives on the failure plane
// (caseOutcome's cancelled/infraFailed denominators); partial work under a kill entering a metric mean is the
// same masquerade as a dead grader's zero. (Collect-stage failures keep their compute-bound measurements —
// the run completed; only its observability died.)
export function summarizeScorecard(sc: Scorecard): MetricSummary[] {
  const byMetric = new Map<
    string,
    { values: number[]; passes: boolean[]; labeled: { label: string; value: number }[]; unmeasured: number }
  >();
  for (const result of sc.results) {
    const f = result.failure;
    if (f && (f.code === "CANCELLED" || PRE_OUTCOME_STAGES.has(f.stage))) continue;
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
      // A metric whose every score was unmeasured/invalid has NO mean — 0 here crowned dead graders on
      // lower-is-better leaderboards and drew outages as regressions on trend lines.
      ...(m.values.length > 0 ? { mean: m.values.reduce((a, b) => a + b, 0) / m.values.length } : {}),
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

// How much of a batch's score plane was an actual MEASUREMENT. Aggregates already exclude unmeasured scores,
// which is why a hollowed-out batch can look perfectly healthy: every surviving number is real, there are just
// far fewer of them than anyone asked for. A release gate ships on evidence, so it needs the ratio as an
// INPUT to the decision rather than as a footnote nobody reads.
// Counted over exactly the cases summarizeScorecard aggregates (a no-outcome case — cancelled, or dead before
// an outcome — contributes nothing at all), so the denominator matches the metric plane it describes.
export interface MeasurementCoverage {
  scores: number; // scores on outcome-bearing cases
  unmeasured: number; // of those, the ones that were not measurements (grader death / judge skip)
  // unmeasured / scores — ABSENT when there were no scores at all (a ratio over nothing is not 0).
  unmeasuredFraction?: number;
}

export function measurementCoverage(sc: Pick<Scorecard, "results">): MeasurementCoverage {
  let scores = 0;
  let unmeasured = 0;
  for (const result of sc.results) {
    const f = result.failure;
    if (f && (f.code === "CANCELLED" || PRE_OUTCOME_STAGES.has(f.stage))) continue;
    for (const s of result.scores) {
      scores++;
      if (!isMeasured(s)) unmeasured++;
    }
  }
  return { scores, unmeasured, ...(scores > 0 ? { unmeasuredFraction: unmeasured / scores } : {}) };
}

export interface CaseDelta {
  caseId: string;
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  passChange?: "fixed" | "broke";
}
// The CASE-VERDICT transition — the unit a release decision is made in. A metric-level pass flip
// (CaseDelta.passChange) says WHY a case moved; whether the case's product verdict moved is decided by the
// authority ladder (caseVerdict under each side's OWN policy), and only that transition counts as a
// regression. Without this split, a diagnostic judge flip on a case whose ground truth still passes reads
// as "case flipped pass → fail" to a gate — a claim the case verdict itself contradicts — and one case with
// three flipped metrics counts as three regressions.
export interface CaseTransition {
  caseId: string;
  trial?: number;
  baseline?: boolean; // that side's case verdict; absent = the side produced no verdict
  candidate?: boolean;
  // "unmeasured" = at least one side has no verdict for this shared case — not comparable, never a regression.
  change: "broke" | "fixed" | "same" | "unmeasured";
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
  // Metric-level pass flips — DIAGNOSIS (which metric moved on which case), never the release-regression
  // unit. The gate counts `caseTransitions` with change "broke"; these arrays explain them.
  regressions: CaseDelta[];
  improvements: CaseDelta[];
  // Case-VERDICT transitions over shared (case, trial) pairs — the regression unit a gate decides in.
  // Same unit as diffTrials' per-case rates, so trials=1 and trials>1 gate on the same claim.
  caseTransitions: CaseTransition[];
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
function scoreMap(sc: Scorecard): Map<string, { caseId: string; metrics: Map<string, MeasuredScore> }> {
  const m = new Map<string, { caseId: string; metrics: Map<string, MeasuredScore> }>();
  for (const result of sc.results) {
    const key = `${result.caseId}#${result.trial ?? 0}`;
    const entry = m.get(key) ?? { caseId: result.caseId, metrics: new Map<string, MeasuredScore>() };
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
    // Only a case a re-SCORE can actually recover belongs on this worklist: a result carrying a classified
    // failure (dispatch death, collect starvation) recovers through retry/re-collect, not through scoring —
    // listing its placeholders here made the rescore button an empty promise.
    if (r.failure !== undefined) continue;
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

// Case-verdict transitions over the (caseId, trial) pairs BOTH sides ran. Each side's verdict is derived
// under ITS OWN policy — the stamped document that produced that side's historical verdicts — so the
// transition compares what each batch actually claimed, not a re-judgment under one ladder.
function caseTransitions(
  baseline: Scorecard,
  candidate: Scorecard,
  baselinePolicy: VerdictPolicy,
  candidatePolicy: VerdictPolicy,
): CaseTransition[] {
  const byKey = (sc: Scorecard): Map<string, CaseResult> => {
    const m = new Map<string, CaseResult>();
    for (const r of sc.results) m.set(`${r.caseId}#${r.trial ?? 0}`, r);
    return m;
  };
  const b = byKey(baseline);
  const c = byKey(candidate);
  const out: CaseTransition[] = [];
  for (const [key, cResult] of c) {
    const bResult = b.get(key);
    if (!bResult) continue; // one-sided cases are `missing`, first-class already
    const bv = caseVerdict(bResult, baselinePolicy);
    const cv = caseVerdict(cResult, candidatePolicy);
    const change: CaseTransition["change"] =
      bv === undefined || cv === undefined ? "unmeasured" : bv && !cv ? "broke" : !bv && cv ? "fixed" : "same";
    out.push({
      caseId: cResult.caseId,
      ...(cResult.trial !== undefined ? { trial: cResult.trial } : {}),
      ...(bv !== undefined ? { baseline: bv } : {}),
      ...(cv !== undefined ? { candidate: cv } : {}),
      change,
    });
  }
  return out;
}

// baseline(vA) vs candidate(vB). The release-regression unit is the CASE-VERDICT transition
// (`caseTransitions`, each side judged under its own policy); metric-level pass flips stay as diagnosis
// (`regressions`/`improvements` explain which metric moved). Numeric deltas are interpreted through the
// policy's declared directions (no direction ⇒ "unknown", never a sign guess). Missingness is an OUTPUT:
// one-sided cases/metrics are enumerated, aggregate means are computed only over both-sided metrics (the
// old `?? 0` fill made a vanished grader read as a mean that crashed to zero, while the case-level loop
// silently skipped the very same absence), and `comparability` says whether the comparison holds at all.
export function diffScorecards(
  baseline: Scorecard,
  candidate: Scorecard,
  opts: { policy?: VerdictPolicy; baselinePolicy?: VerdictPolicy; candidatePolicy?: VerdictPolicy } = {},
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
  const transitions = caseTransitions(
    baseline,
    candidate,
    opts.baselinePolicy ?? policy,
    opts.candidatePolicy ?? policy,
  );
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
    caseTransitions: transitions,
    missing,
    incomparable,
    overlap: { sharedCases, baselineCases: bCases.size, candidateCases: cCases.size },
    comparability,
  };
}
