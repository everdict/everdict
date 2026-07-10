// Weighted Fair Queueing now lives in @everdict/domain — re-architecture P1d compat re-export
// (removed in the P4 sweep). New code should import @everdict/domain directly.
export { FairQueue, type FairQueueOptions } from "@everdict/domain";
