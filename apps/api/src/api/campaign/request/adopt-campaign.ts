import { CampaignAdoptionProofSchema } from "@everdict/contracts";
import { z } from "zod";

// ── SPENDING A CAMPAIGN'S ADOPTION AUTHORIZATION (arch-review 73) ────────────────────────────────────
//
// The caller presents the PROOF the campaign recorded and the SPEC it is registering. Both are required and
// both are checked, against different things:
//
//   proof   compared as a digest against the operation the settle wrote — a structurally-equal proof the
//           campaign never issued is not authority (rule `protocol` L3).
//   spec    registered, then read back through the registry and digested — because a version label cannot
//           tell an evaluated C1 from a saved C2, and the caller's own copy is not evidence about what the
//           registry now holds.
//
// `spec` is unvalidated HERE on purpose: which schema applies depends on the proof's candidate family
// (AgentSpec vs HarnessInstanceSpec), and the composition root that owns those registries parses it. A DTO
// that guessed would be a second parser for a decision it does not own.
export const AdoptCampaignBodySchema = z.object({
  proof: CampaignAdoptionProofSchema,
  spec: z.unknown(),
});
export type AdoptCampaignBody = z.infer<typeof AdoptCampaignBodySchema>;
