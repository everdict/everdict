import { z } from "zod";

// GET /harness-templates 200 — one entry per template id (workspace-owned + _shared fallback).
export const HarnessTemplateListEntrySchema = z.object({
  id: z.string(),
  versions: z.array(z.string()).describe("Live versions (semver ascending)"),
  owner: z.string().describe("Owning tenant, or _shared for first-party content"),
});

export const HarnessTemplateListResponseSchema = z.array(HarnessTemplateListEntrySchema);
