import { z } from "zod";

// GET /internal/schedules/scorecard-status/:scorecardId — poll-to-terminal status for the workflow.
export const ScorecardStatusResponseSchema = z.object({
  status: z.string().nullable().describe("The fired scorecard's current status; null when unknown"),
});
