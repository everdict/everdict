import { z } from "zod";

// Content editing only — status moves go through POST /issues/:id/status so a transition can never be a silent
// side effect of a rename. `null` clears an optional field (unassign, detach from a project).
export const UpdateIssueBodySchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(50_000).nullable().optional(),
    labels: z.array(z.string().min(1).max(100)).max(50).optional(),
    assignee: z.string().min(1).max(200).nullable().optional(),
    projectId: z.string().min(1).max(200).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update.");
