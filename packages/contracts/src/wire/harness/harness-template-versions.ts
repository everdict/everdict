import { z } from "zod";

// GET /harness-templates/:id 200 — the template id's live versions.
export const HarnessTemplateVersionsResponseSchema = z.object({
  id: z.string(),
  versions: z.array(z.string()).describe("Live versions (semver ascending)"),
});
export type HarnessTemplateVersionsResponse = z.infer<typeof HarnessTemplateVersionsResponseSchema>;
