import { z } from "zod";

const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// Content editing only — status moves go through POST /projects/:id/status so a completion (and its open-issue
// gate) can never be a side effect of a rename. `null` clears an optional field (drop the target date); a LIST
// replaces what is there, so `[]` is how a caller detaches every initiative. Not every team, though: a project
// is worked by at least one, so an empty team list is refused here rather than at the aggregate — the caller
// asking to detach the last one gets told what the rule is, not that the update was empty.
export const UpdateProjectBodySchema = z
  .object({
    name: z.string().min(1).max(300).optional(),
    description: z.string().max(50_000).nullable().optional(),
    teamIds: z.array(z.string().min(1).max(200)).min(1, "A project is worked by at least one team.").max(50).optional(),
    initiativeIds: z.array(z.string().min(1).max(200)).max(20).optional(),
    // `null` clears the lead; the member list replaces, like the other lists.
    lead: z.string().min(1).max(200).nullable().optional(),
    memberIds: z.array(z.string().min(1).max(200)).max(200).optional(),
    targetDate: CalendarDateSchema.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update.");
