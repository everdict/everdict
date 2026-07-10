// ScorecardService now lives in @everdict/application-control — re-architecture P2 S4 compat re-export
// (removed in the P4 sweep). New code should import @everdict/application-control directly. The shared
// declarations the facade re-exported (schemas, deps, inputs) stay importable from this path too.
export {
  IngestScorecardBodySchema,
  PullIngestBodySchema,
  ScorecardService,
  type IngestScorecardBody,
  type IngestScorecardInput,
  type PullIngestBody,
  type PullIngestInput,
  type RunScorecardInput,
  type ScorecardServiceDeps,
  originSource,
  selectSubsetCases,
} from "@everdict/application-control";
