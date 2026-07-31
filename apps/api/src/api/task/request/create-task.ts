import { z } from "zod";

export const CreateTaskBodySchema = z.object({
  subject: z.string().min(1).max(300), // imperative title — the unit of work
  description: z.string().max(10_000).optional(),
  owner: z.string().min(1).max(200).optional(), // pre-assign; else claiming (→ in_progress) records the claimer
  blockedBy: z.array(z.string().min(1)).max(20).default([]), // informational dependency (task ids)
});
