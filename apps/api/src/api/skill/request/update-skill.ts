import { SkillVisibilitySchema } from "@everdict/contracts";
import { z } from "zod";

// PATCH /skills/:id body — edit a skill or change its visibility ("share to workspace" = private→workspace). Every
// field is optional (a visibility-only PATCH is the share toggle). Manage = creator-or-admin (enforced in the service).
export const UpdateSkillBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    instructions: z.string().min(1).optional(),
    visibility: SkillVisibilitySchema.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "at least one field is required" });
