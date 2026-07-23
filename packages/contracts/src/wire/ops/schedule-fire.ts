import { z } from "zod";

// POST /internal/schedules/:id/fire — the scorecard the fire submitted (ScheduleService.fire).
export const ScheduleFireResponseSchema = z.object({
  scorecardId: z.string().describe("The scorecard submitted by this fire"),
});
export type ScheduleFireResponse = z.infer<typeof ScheduleFireResponseSchema>;
