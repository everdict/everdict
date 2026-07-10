// @everdict/domain — THE unique domain layer (L1). Every business rule has exactly one
// implementation here (re-architecture P1, docs/architecture/rearchitecture/00-target-architecture.md).
// Pure by construction: imports @everdict/contracts only — no I/O, no stores, no SDKs.
// Grouped by domain (scorecard/, run/, member/, …); the barrel re-exports every public symbol.

// scorecard — verdict authority + pass@k trials + diff/z-test + leaderboard/trend/models (from @everdict/suite)
export {
  type CaseDelta,
  caseVerdict,
  diffScorecards,
  type MetricSummary,
  type ScorecardDiff,
  scorecardPassRate,
  summarizeScorecard,
} from "./scorecard/scorecard.js";
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
} from "./scorecard/trials.js";
export {
  type Leaderboard,
  leaderboard,
  type LeaderboardCard,
  type LeaderboardRow,
} from "./scorecard/leaderboard.js";
export {
  type ScorecardTrend,
  type TrendCard,
  type TrendPoint,
  trendSeries,
} from "./scorecard/trend.js";
export { type ScorecardModels, scorecardModels } from "./scorecard/models.js";

// auth — the role→action matrix + the identity subject shape (from @everdict/auth)
export {
  type Action,
  API_KEY_SCOPES,
  type ApiKeyScope,
  authorize,
  can,
  EVERDICT_ROLES,
  type EverdictRole,
} from "./auth/authz.js";
export type { AuthContext, Principal } from "./auth/principal.js";

// billing — cost attribution + enforcement budget + metered usage (from @everdict/billing)
export { billingTenant, costOf, sumCost } from "./billing/cost.js";
export {
  assertWithinBudget,
  type BudgetLimit,
  type BudgetTracker,
  type BudgetUsage,
  inMemoryBudget,
  type InMemoryBudgetOptions,
} from "./billing/budget.js";
export {
  inMemoryUsageMeter,
  type TenantUsage,
  totalUsage,
  USAGE_SOURCES,
  type UsageMeter,
  type UsageSource,
  type UsageTotals,
} from "./billing/usage.js";
