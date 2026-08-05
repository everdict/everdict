import { z } from "zod";
import { CapabilityOriginSchema } from "../../records/capability-origin.js";

// GET /harnesses 200 — one entry per harness id: version meta (registration history) + display fields derived
// from the latest instance. Mirrors HarnessListEntry (@everdict/registry harness-instance-registry.ts).
export const HarnessListEntrySchema = z.object({
  id: z.string(),
  owner: z.string().describe("Owning tenant, or _shared for first-party content"),
  teamId: z
    .string()
    .optional()
    .describe("Owning team (migration 0106) — absent means unowned (a _shared entry, or one from before the axis)"),
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
  versionOrigins: z
    .record(CapabilityOriginSchema)
    .optional()
    .describe("version → where that version came from (stamped versions only)"),
  category: z.string().optional().describe("Template category of the latest instance"),
  // The shape the latest instance rides on. Two harnesses that vary only by env/pins are two entries under ONE
  // template — without this the list cannot say so, and every variation reads as an unrelated harness.
  templateId: z.string().optional().describe("Template (shape) id of the latest instance"),
  templateVersion: z.string().optional().describe("Template (shape) version of the latest instance"),
  // Derived from the latest instance's own delta — what makes THIS harness different from its shape. Never
  // authored, so it cannot go stale; absent when the instance is the template unchanged.
  variation: z
    .array(z.object({ scope: z.string().optional(), label: z.string() }))
    .optional()
    .describe("How the latest instance differs from its template (display chips)"),
  kind: z.string().optional().describe("command | service | process (resolved)"),
  subtitle: z.string().optional().describe("Model/command/service summary for list display"),
  private: z.boolean().optional().describe("True when the latest instance references a personal secret"),
});
export type HarnessListEntry = z.infer<typeof HarnessListEntrySchema>;

export const HarnessListResponseSchema = z.array(HarnessListEntrySchema);
export type HarnessListResponse = z.infer<typeof HarnessListResponseSchema>;
