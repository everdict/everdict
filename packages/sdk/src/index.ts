// @everdict/sdk — the one-call developer surface over the Everdict control plane. docs/architecture/one-call-sdk.md
export { EverdictClient, EverdictError, type EverdictClientOptions } from "./client.js";
export type {
  DatasetInput,
  EvaluateInput,
  HarnessInput,
  Leaderboard,
  LeaderboardQuery,
  LeaderboardRow,
  MetricSummary,
  Ref,
  ScorecardDiff,
  ScorecardRecord,
  SdkFetch,
  SdkResponse,
  TrialCaseDelta,
  TrialSummary,
  Verdict,
} from "./types.js";
