import { z } from "zod";

// GET /harnesses 200 — one entry per harness id: version meta (registration history) + display fields derived
// from the latest instance. Mirrors HarnessListEntry (@everdict/registry harness-instance-registry.ts).
export const HarnessListEntrySchema = z.object({
  id: z.string(),
  owner: z.string().describe("Owning tenant, or _shared for first-party content"),
  versions: z.array(z.string()).describe("Live versions (semver ascending)"),
  latestVersion: z.string(),
  versionCount: z.number().int(),
  createdBy: z.string().optional().describe("Subject of the first-registered version (absent for seed/_shared)"),
  latestCreatedBy: z
    .string()
    .optional()
    .describe("Subject of the latest version (privacy owner for private harnesses)"),
  createdAt: z.string().optional().describe("First registration time (ISO)"),
  updatedAt: z.string().optional().describe("Most recent registration time (ISO)"),
  versionTags: z.record(z.array(z.string())).optional().describe("version → free-form labels (tagged versions only)"),
  category: z.string().optional().describe("Template category of the latest instance"),
  kind: z.string().optional().describe("command | service | process (resolved)"),
  subtitle: z.string().optional().describe("Model/command/service summary for list display"),
  private: z.boolean().optional().describe("True when the latest instance references a personal secret"),
});

export const HarnessListResponseSchema = z.array(HarnessListEntrySchema);
