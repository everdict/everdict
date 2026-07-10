// The Run aggregate now lives in @everdict/domain — re-architecture P1c compat re-export
// (removed in the P4 sweep). New code should import @everdict/domain directly.
export { type NewQueuedRunInput, Run, type RunTransition } from "@everdict/domain";
