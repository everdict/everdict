import { z } from "zod";

// GET /harness-templates 200 — one entry per template id (workspace-owned + _shared fallback).
export const HarnessTemplateListEntrySchema = z.object({
  id: z.string(),
  versions: z.array(z.string()).describe("Live versions (semver ascending)"),
  owner: z.string().describe("Owning tenant, or _shared for first-party content"),
  // What the shape IS, read off its latest version. A shape no harness rides yet appears only in this list, so
  // without these it would be a bare id — and the catalog exists precisely to make those visible.
  latestVersion: z.string().optional(),
  kind: z.string().optional().describe("command | service | process"),
  category: z.string().optional(),
  serviceCount: z.number().int().optional().describe("Service shapes only — how many services the topology stands up"),
});
export type HarnessTemplateListEntry = z.infer<typeof HarnessTemplateListEntrySchema>;

export const HarnessTemplateListResponseSchema = z.array(HarnessTemplateListEntrySchema);
export type HarnessTemplateListResponse = z.infer<typeof HarnessTemplateListResponseSchema>;
