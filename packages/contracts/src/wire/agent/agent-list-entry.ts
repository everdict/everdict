import { z } from "zod";
import { CapabilityOriginSchema } from "../../records/capability-origin.js";

// GET /agents 200 — one entry per agent id (workspace-owned + _shared fallback).
export const AgentListEntrySchema = z.object({
  id: z.string(),
  versions: z.array(z.string()).describe("Versions (semver ascending)"),
  owner: z.string().describe("Owning tenant, or _shared for first-party agents"),
  // Creator subject of the first-registered version (none for seed/_shared). Surfaces who may soft-delete the agent (creator or admin).
  createdBy: z.string().optional(),
  teamId: z
    .string()
    .optional()
    .describe("Owning team — absent means unowned (a _shared entry, or one from before the axis)"),
  versionOrigins: z
    .record(CapabilityOriginSchema)
    .optional()
    .describe("version → where that version came from (stamped versions only)"),
});
export type AgentListEntry = z.infer<typeof AgentListEntrySchema>;

export const AgentListResponseSchema = z.array(AgentListEntrySchema);
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;
