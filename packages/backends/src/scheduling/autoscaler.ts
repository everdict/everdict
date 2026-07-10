// The queue-depth autoscaler now lives in @everdict/domain — re-architecture P1d compat
// re-export (removed in the P4 sweep). New code should import @everdict/domain directly.
export {
  aggregateLoad,
  type AutoscalePolicy,
  Autoscaler,
  type AutoscalerOptions,
  desiredCapacity,
  type LoadSignal,
  MutableSlots,
  type ScalingTarget,
} from "@everdict/domain";
