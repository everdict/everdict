import { IssueStatusSchema } from "@everdict/contracts";
import { z } from "zod";

// One endpoint for every workflow move. The service picks the domain transition that fits the current state
// (move / resolve / reopen), so a caller says where the issue should end up, not which verb to use.
export const SetIssueStatusBodySchema = z.object({
  status: IssueStatusSchema,
  // Required in spirit for `done` — an issue closes with the scorecard that proved it. The scorecard id is
  // validated against this workspace; the note carries the human half.
  resolution: z
    .object({
      scorecardId: z.string().min(1).max(200).optional(),
      note: z.string().max(2000).optional(),
    })
    .optional(),
});
