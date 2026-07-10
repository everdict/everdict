// The scorecard shared plumbing (deps interface, ingest/pull body schemas, subset/grading-plan helpers) now
// lives in @everdict/application-control — re-architecture P2 S4 compat re-export (removed in the P4 sweep).
// New code should import @everdict/application-control directly.
export {
  IngestScorecardBodySchema,
  PullIngestBodySchema,
  type IngestScorecardBody,
  type IngestScorecardInput,
  type PullIngestBody,
  type PullIngestInput,
  type RunScorecardInput,
  type ScorecardServiceDeps,
  applyGradingPlan,
  caseReason,
  childKey,
  exportStepMessage,
  offloadResults,
  originSource,
  selectSubsetCases,
} from "@everdict/application-control";
