// The sink contract now lives in @everdict/contracts — re-architecture P2d compat re-export
// (removed in the P4 sweep). Adapter interfaces live in the contract root (the repo's deliberate
// inversion); the fetch-backed sink impls stay here.
export type {
  TraceSink,
  TraceSinkCase,
  TraceSinkCaseResult,
  TraceSinkConfig,
  TraceSinkContext,
  TraceSinkResult,
  TraceSinkScore,
} from "@everdict/contracts";
