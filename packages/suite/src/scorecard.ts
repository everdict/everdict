// Scorecard verdict/summary/diff semantics now live in @everdict/domain — re-architecture P1a
// compat re-export (removed in the P4 sweep). New code should import @everdict/domain directly.
export {
  type CaseDelta,
  caseVerdict,
  diffScorecards,
  type MetricSummary,
  type ScorecardDiff,
  scorecardPassRate,
  summarizeScorecard,
} from "@everdict/domain";
