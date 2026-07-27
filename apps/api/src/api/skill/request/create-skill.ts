import { SkillFilesSchema, SkillVisibilitySchema } from "@everdict/contracts";
import { z } from "zod";

// POST /skills body — author a workspace skill. visibility defaults to "private" (a personal draft); "share to
// workspace" is an explicit visibility promotion (here or via PATCH). `files` are the skill's supporting reference
// files (progressive disclosure: each loads on demand via read_skill_file, never inlined with the body).
export const CreateSkillBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().min(1),
  files: SkillFilesSchema.optional(),
  visibility: SkillVisibilitySchema.optional(),
});
