import { z } from "zod";
import { ScoreSchema } from "./grader.js";
import { ImageProvenanceSchema } from "./image-provenance.js";
import { RuntimeWorkRefSchema } from "./runtime-work-ref.js";

// The sealed form of a verifier invocation, as a record carries it (arch-review 57 P1). The SHAPE lives here
// because a persisted `CaseResult` declares it; the sealing — digesting the verdict plane, deciding whether
// the runtime identity is present — is `verifierReceiptOf` in @everdict/domain, which is where digesting
// belongs. One document, one schema, both ends: a capability spelled twice grows its next field in one of
// them (rule `suite`).
export const VerifierReceiptSchema = z.object({
  planDigest: z.string().min(1),
  workspaceDigest: z.string().min(1),
  work: RuntimeWorkRefSchema.optional(),
  imageProvenance: ImageProvenanceSchema.optional(),
  scores: z.array(ScoreSchema),
  scoreDigest: z.string().min(1),
  // Whether the runtime identity is here too. A receipt without it is still evidence; a consumer that cannot
  // tell would count the weaker record as the stronger one.
  complete: z.boolean(),
});
export type VerifierReceiptRecord = z.infer<typeof VerifierReceiptSchema>;
