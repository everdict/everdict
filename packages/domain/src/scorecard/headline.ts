import type { MetricSummary } from "./scorecard.js";
import type { ScorecardTrialSummary } from "./trials.js";

// Authoritative-first metric order for a single headline pass rate (the same ranking as caseVerdict).
const PASS_RATE_METRICS = ["tests_pass", "state", "answer_match", "url_matches", "dom_contains", "judge"];

// Reduce a scorecard's aggregates to a single headline pass rate. Trial-aware: prefer the case-weighted
// trial pass rate; else the highest-authority metric that carries a pass rate; else any; else null
// (nothing pass-deciding). Input is the *lightweight* record shape (list summary is enough) — the SDK's
// Verdict and any dashboard headline read this served value instead of re-implementing the ranking.
export function headlinePassRate(record: {
  trialSummary?: Pick<ScorecardTrialSummary, "passAt1">;
  summary?: MetricSummary[];
}): number | null {
  if (record.trialSummary) return record.trialSummary.passAt1;
  const summary = record.summary ?? [];
  for (const metric of PASS_RATE_METRICS) {
    const s = summary.find((x) => x.metric === metric && x.passRate !== undefined);
    if (s?.passRate !== undefined) return s.passRate;
  }
  return summary.find((x) => x.passRate !== undefined)?.passRate ?? null;
}
