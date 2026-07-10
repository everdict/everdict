import { z } from "zod";

// POST /harness-templates 201 — registered template coordinates.
export const RegisterHarnessTemplateResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
});
export type RegisterHarnessTemplateResult = z.infer<typeof RegisterHarnessTemplateResultSchema>;
