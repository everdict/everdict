// The Schedule aggregate now lives in @everdict/domain — re-architecture P1c compat re-export
// (removed in the P4 sweep). New code should import @everdict/domain directly.
export {
  isValidCron,
  type NewScheduleInput,
  Schedule,
  type ScheduleActor,
  type ScheduleSpec,
  type ScheduleTransition,
} from "@everdict/domain";
