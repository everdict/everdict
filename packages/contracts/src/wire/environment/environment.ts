import { z } from "zod";
import { CapabilityOriginSchema } from "../../records/capability-origin.js";

// POST /environments 201 — registered coordinates (harness-definability-spec.md §2).
export const RegisterEnvironmentResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  // Warn-not-block advice about the world's bytes — same shape the harness register door returns.
  imageWarnings: z.array(z.object({ image: z.string(), class: z.string() })).optional(),
});
export type RegisterEnvironmentResult = z.infer<typeof RegisterEnvironmentResultSchema>;

// GET /environments 200 — one entry per environment id. Mirrors EnvironmentListEntry (@everdict/registry).
export const EnvironmentListEntrySchema = z.object({
  id: z.string(),
  versions: z.array(z.string()).describe("Versions (semver ascending)"),
  owner: z.string().describe("Owning tenant, or _shared for first-party environments"),
  versionTags: z.record(z.array(z.string())).optional().describe("version → free-form labels (tagged versions only)"),
  versionOrigins: z
    .record(CapabilityOriginSchema)
    .optional()
    .describe("version → where that version came from (stamped versions only)"),
});
export type EnvironmentListEntry = z.infer<typeof EnvironmentListEntrySchema>;

export const EnvironmentListResponseSchema = z.array(EnvironmentListEntrySchema);
export type EnvironmentListResponse = z.infer<typeof EnvironmentListResponseSchema>;
