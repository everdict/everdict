import { ProjectHealthSchema } from "@everdict/contracts";
import { z } from "zod";

// Posting a project update — the one JUDGMENT the tracker records, which is why the body is required: a health
// flag with no sentence is a colour nobody can explain.
export const PostProjectUpdateBodySchema = z.object({
  health: ProjectHealthSchema,
  body: z.string().min(1).max(50_000),
});

// A milestone is a checkpoint inside the project. Order is the meaning (they are steps toward a date), so a new
// one goes at the end — `sortOrder` is the server's, never the caller's.
export const AddMilestoneBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  targetDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.")
    .optional(),
});
