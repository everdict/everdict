import { ScheduleRecordSchema } from "@everdict/db";
import { z } from "zod";

// Response DTO — a schedule record. The @everdict/db ScheduleRecordSchema is the SSOT shape; get/list
// additionally attach Temporal-computed next fire times (ScheduleRecordWithNext, best-effort).
export const ScheduleResponseSchema = ScheduleRecordSchema.extend({
  nextFireTimes: z
    .array(z.string())
    .optional()
    .describe("Upcoming fire times (ISO, Temporal authoritative) — best-effort, absent when the driver is offline"),
});
