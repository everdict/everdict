import { z } from "zod";
import { DatasetProvenanceSchema } from "../../execution/dataset.js";

// GET /datasets 200 — one entry per dataset id: registration history + display fields from the latest version.
// Mirrors DatasetListEntry (@everdict/registry dataset-registry.ts).
export const DatasetListEntrySchema = z.object({
  id: z.string(),
  owner: z.string().describe("Owning tenant, or _shared for first-party benchmarks"),
  versions: z.array(z.string()).describe("Live versions (semver ascending)"),
  latestVersion: z.string(),
  caseCount: z.number().int().describe("Case count of the latest version"),
  tags: z.array(z.string()).describe("Content tags of the latest version"),
  description: z.string().optional(),
  producedBy: DatasetProvenanceSchema.optional().describe(
    "Ingest provenance of the latest version (recipe/catalog/spec)",
  ),
  createdBy: z
    .string()
    .optional()
    .describe("Creator subject of the first-registered version (absent for seed/_shared)"),
  createdAt: z.string().optional().describe("First registration time (ISO)"),
  updatedAt: z.string().optional().describe("Most recent registration time (ISO)"),
  versionTags: z.record(z.array(z.string())).optional().describe("version → free-form labels (tagged versions only)"),
});

export const DatasetListResponseSchema = z.array(DatasetListEntrySchema);
