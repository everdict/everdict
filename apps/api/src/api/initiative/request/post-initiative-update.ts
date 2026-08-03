import { TrackerHealthSchema } from "@everdict/contracts";
import { z } from "zod";

// Reporting on the GOAL — the same judgment a project update carries, one level up, which is why the body is
// required here too: a health flag with no sentence is a colour nobody can explain.
export const PostInitiativeUpdateBodySchema = z.object({
  health: TrackerHealthSchema,
  body: z.string().min(1).max(50_000),
});
