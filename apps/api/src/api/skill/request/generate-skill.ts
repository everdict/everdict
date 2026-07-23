import { z } from "zod";

// POST /skills/generate body — skill-generate. A natural-language description + the registered model id that drafts it.
export const GenerateSkillBodySchema = z.object({
  description: z.string().min(1),
  model: z.string().min(1).describe("Registered model id used to draft the skill"),
});
