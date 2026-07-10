// Trial/pass@k semantics now live in @everdict/domain — re-architecture P1a compat re-export
// (removed in the P4 sweep). New code should import @everdict/domain directly.
export {
  type CaseTrialStats,
  caseTrialStats,
  diffTrials,
  groupTrials,
  passAtK,
  type ScorecardTrialSummary,
  summarizeTrials,
  type TrialCaseDelta,
  type TrialDiff,
} from "@everdict/domain";
