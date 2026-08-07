import type { MetricSummary } from "./scorecard.js";
import type { ScorecardTrialSummary } from "./trials.js";

// Authoritative-first metric order for a single headline pass rate — the SAME order as the verdict policy's
// ground-truth rung (state before tests_pass): the headline and the verdict must never rank differently.
const PASS_RATE_METRICS = ["state", "tests_pass", "answer_match", "url_matches", "dom_contains", "judge"];
// Real judges summarize under `judge:<id>` (top level; deeper = diagnostic criteria) — the literal "judge"
// above only covers the legacy name, same dead-name family as the caseVerdict judge-rung fix.
const isJudgeOverallMetric = (metric: string): boolean => /^judge:[^:]+$/.test(metric);

// Reduce a scorecard's aggregates to a single headline pass rate. Trial-aware: prefer the case-weighted
// trial pass rate; else the highest-authority metric that carries a pass rate; else any; else null
// (nothing pass-deciding). Input is the *lightweight* record shape (list summary is enough) — the SDK's
// Verdict and any dashboard headline read this served value instead of re-implementing the ranking.
export function headlinePassRate(record: {
  trialSummary?: Pick<ScorecardTrialSummary, "passAt1" | "cases">;
  summary?: MetricSummary[];
}): number | null {
  // Trial-aware — but an EMPTY trial summary (cases: 0 — every trial unscored/infra-failed) is "nothing
  // pass-deciding", not a 0% product: fall through to the metric ranking (which yields null too when nothing
  // decides). An annihilated batch must never headline as zero percent.
  if (record.trialSummary && record.trialSummary.passAt1 !== undefined && (record.trialSummary.cases ?? 1) > 0)
    return record.trialSummary.passAt1;
  const summary = record.summary ?? [];
  for (const metric of PASS_RATE_METRICS) {
    const s = summary.find((x) => x.metric === metric && x.passRate !== undefined);
    if (s?.passRate !== undefined) return s.passRate;
  }
  // judge rank continues with the real judge metrics before the anything-goes fallback.
  const judge = summary.find((x) => isJudgeOverallMetric(x.metric) && x.passRate !== undefined);
  if (judge?.passRate !== undefined) return judge.passRate;
  return summary.find((x) => x.passRate !== undefined)?.passRate ?? null;
}

// The default analysis metric for a SET of cards (trend/leaderboard axis when the caller names none): the
// highest-authority metric that actually carries a pass rate anywhere in the set — same ladder as
// headlinePassRate — else any pass-rate-bearing metric, else the first metric present. Replaces the
// hardcoded "judge"/"tests_pass" defaults: a workspace whose graders emit `state` or `judge:<id>` got a
// silently empty board under a literal default.
export function preferredMetric(cards: Array<{ summary?: MetricSummary[] }>): string | undefined {
  const summaries = cards.flatMap((c) => c.summary ?? []);
  for (const metric of PASS_RATE_METRICS) {
    if (summaries.some((s) => s.metric === metric && s.passRate !== undefined)) return metric;
  }
  const judge = summaries.find((s) => isJudgeOverallMetric(s.metric) && s.passRate !== undefined);
  if (judge) return judge.metric;
  return (summaries.find((s) => s.passRate !== undefined) ?? summaries[0])?.metric;
}
