import { z } from "zod";

// GET /judges 200 — one entry per judge id: version meta + display fields derived from the latest spec.
// Mirrors JudgeListEntry (@everdict/registry judge-registry.ts).
export const JudgeListEntrySchema = z.object({
  id: z.string(),
  owner: z.string().describe("Owning tenant, or _shared for first-party judges"),
  versions: z.array(z.string()).describe("Versions (semver ascending)"),
  latestVersion: z.string(),
  versionCount: z.number().int(),
  kind: z.string().optional().describe("code | model | harness"),
  provider: z.string().optional().describe("Model judge: anthropic | openai"),
  model: z.string().optional().describe("Model judge: model id"),
  description: z.string().optional(),
  subtitle: z.string().optional().describe("provider/model or → harness summary for list display"),
  createdBy: z.string().optional().describe("Subject of the first-registered version (absent for seed/_shared)"),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  versionTags: z.record(z.array(z.string())).optional().describe("version → free-form labels (tagged versions only)"),
});
export type JudgeListEntry = z.infer<typeof JudgeListEntrySchema>;

export const JudgeListResponseSchema = z.array(JudgeListEntrySchema);
export type JudgeListResponse = z.infer<typeof JudgeListResponseSchema>;
