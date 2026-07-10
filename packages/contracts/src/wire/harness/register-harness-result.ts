import { z } from "zod";
import { ImageWarningSchema } from "./image-warning.js";

// POST /harnesses 201 — registered coordinates + write-time advisories (image warnings, personal-secret privacy).
export const RegisterHarnessResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  imageWarnings: z.array(ImageWarningSchema).optional().describe("Present only when non-empty (warn-not-block)"),
  private: z
    .boolean()
    .optional()
    .describe("Present (true) only when the spec references a personal secret — visible to the creator only"),
});
export type RegisterHarnessResult = z.infer<typeof RegisterHarnessResultSchema>;
