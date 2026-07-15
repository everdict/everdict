import { z } from "zod";

// GET /runtimes 200 — one entry per runtime id. Mirrors RuntimeListEntry (@everdict/registry runtime-registry.ts).
export const RuntimeListEntrySchema = z.object({
  id: z.string(),
  versions: z.array(z.string()).describe("Versions (semver ascending)"),
  owner: z.string().describe("Owning tenant, or _shared for first-party runtimes"),
  versionTags: z.record(z.array(z.string())).optional().describe("version → free-form labels (tagged versions only)"),
  capabilities: z
    .array(z.string())
    .optional()
    .describe("Latest version's declared capabilities — for submit-time runtime↔harness fit preview (absent = none)"),
});
export type RuntimeListEntry = z.infer<typeof RuntimeListEntrySchema>;

export const RuntimeListResponseSchema = z.array(RuntimeListEntrySchema);
export type RuntimeListResponse = z.infer<typeof RuntimeListResponseSchema>;
