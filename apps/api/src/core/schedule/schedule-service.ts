// ScheduleService now lives in @everdict/application-control — re-architecture P2 S4 compat re-export
// (removed in the P4 sweep). New code should import @everdict/application-control directly.
export {
  type CreateScheduleInput,
  type RegressionAlert,
  type RegressionDelta,
  type ScheduleDriver,
  type ScheduleRecordWithNext,
  ScheduleService,
  type ScheduleServiceDeps,
  type ScheduleSpec,
  type UpdateScheduleInput,
  isValidCron,
} from "@everdict/application-control";
