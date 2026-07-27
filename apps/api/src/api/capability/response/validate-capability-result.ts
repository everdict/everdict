import { CapabilityTypeSchema } from "@everdict/contracts";
import { z } from "zod";

// POST /capabilities/validate response — a schema-failure result (ok:false + human-readable errors) OR a dry-run of
// the save: whether it would create a new version, which version, the existing live versions, and (environment kind)
// image pull-readiness warnings. The wizard's review step renders this before the author commits.
const ImageWarningSchema = z.object({ image: z.string(), class: z.string() });

export const ValidateCapabilityResultSchema = z.union([
  z.object({ ok: z.literal(false), errors: z.array(z.string()) }),
  z.object({
    ok: z.literal(true),
    id: z.string(),
    type: CapabilityTypeSchema,
    willCreate: z.boolean(),
    version: z.string(),
    existingVersions: z.array(z.string()),
    imageWarnings: z.array(ImageWarningSchema).optional(),
  }),
]);
export type ValidateCapabilityResult = z.infer<typeof ValidateCapabilityResultSchema>;
