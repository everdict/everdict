// QueueService now lives in @everdict/application-control — re-architecture P2 S4 compat re-export
// (removed in the P4 sweep). New code should import @everdict/application-control directly.
export {
  type QueueItem,
  type QueueLane,
  type QueueLaneAdmission,
  QueueService,
  type QueueServiceDeps,
  type QueueSnapshot,
  type QueueUpcoming,
} from "@everdict/application-control";
