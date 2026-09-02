import { CapabilityOriginSchema, HarnessSeedsSchema, HarnessSpecDiffSchema } from "@everdict/contracts";
import { z } from "zod";

// GET /harnesses/:id/lineage — one read over a harness's versions (harness-identity-and-seeds-spec.md §3).
export const HarnessLineageResponseSchema = z.object({
  id: z.string(),
  adoptionsKnown: z.boolean(),
  versions: z.array(
    z.object({
      version: z.string(),
      specDigest: z.string(),
      tags: z.array(z.string()),
      origin: CapabilityOriginSchema.optional(),
      predecessor: z.object({ version: z.string(), via: z.enum(["origin", "order"]) }).optional(),
      forkedFrom: z.object({ id: z.string(), version: z.string(), specDigest: z.string() }).optional(),
      bornFrom: CapabilityOriginSchema.shape.from,
      seeds: HarnessSeedsSchema.optional(),
      diff: z
        .object({
          summary: HarnessSpecDiffSchema.shape.summary,
          slots: z.array(z.string()),
          changes: HarnessSpecDiffSchema.shape.changes,
        })
        .optional(),
      adoptedBy: z
        .array(z.object({ campaignId: z.string(), issueId: z.string(), provingScorecardId: z.string() }))
        .optional(),
    }),
  ),
});
