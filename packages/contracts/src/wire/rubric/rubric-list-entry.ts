import { z } from "zod";

// GET /rubrics 200 — one entry per rubric id: version meta + display fields derived from the latest spec.
// Mirrors RubricListEntry (@everdict/registry rubric-registry.ts).
export const RubricListEntrySchema = z.object({
  id: z.string(),
  owner: z.string().describe("Owning tenant, or _shared for first-party rubrics"),
  versions: z.array(z.string()).describe("Versions (semver ascending)"),
  latestVersion: z.string(),
  versionCount: z.number().int(),
  description: z.string().optional(),
  subtitle: z.string().optional().describe("Content summary (text · N criteria · template) for list display"),
  createdBy: z.string().optional().describe("Subject of the first-registered version (absent for seed/_shared)"),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  versionTags: z.record(z.array(z.string())).optional().describe("version → free-form labels (tagged versions only)"),
});
export type RubricListEntry = z.infer<typeof RubricListEntrySchema>;

export const RubricListResponseSchema = z.array(RubricListEntrySchema);
export type RubricListResponse = z.infer<typeof RubricListResponseSchema>;
