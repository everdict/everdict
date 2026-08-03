import { IssuePrioritySchema } from "@everdict/contracts";
import { z } from "zod";

const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// Content editing only — status moves go through POST /issues/:id/status so a transition can never be a silent
// side effect of a rename. `null` clears an optional field (unassign, detach from a project).
export const UpdateIssueBodySchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(50_000).nullable().optional(),
    // Whole-array replacement of the issue's labels, by registry id (GET /issue-labels).
    labelIds: z.array(z.string().min(1).max(200)).max(50).optional(),
    assignee: z.string().min(1).max(200).nullable().optional(),
    projectId: z.string().min(1).max(200).nullable().optional(),
    priority: IssuePrioritySchema.optional(),
    // `null` clears them: no estimate, no due date, no parent (the issue becomes top-level again). Re-parenting
    // under one of its own sub-issues is refused with a 409 — that would close the loop.
    estimate: z.number().int().nonnegative().max(1000).nullable().optional(),
    dueDate: CalendarDateSchema.nullable().optional(),
    parentId: z.string().min(1).max(200).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update.");
