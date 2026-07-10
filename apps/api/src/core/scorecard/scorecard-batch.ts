// The ScorecardBatch aggregate now lives in @everdict/domain — re-architecture P1c compat
// re-export (removed in the P4 sweep). New code should import @everdict/domain directly.
export {
  type NewChildRunInput,
  type NewQueuedBatchInput,
  type NewQueuedIngestInput,
  ScorecardBatch,
  type ScorecardOrchestration,
  type ScorecardOutcomeExtras,
  type ScorecardRunError,
  type ScorecardTransition,
} from "@everdict/domain";
