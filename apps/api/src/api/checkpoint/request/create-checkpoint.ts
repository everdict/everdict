import { HandoffCheckpointSchema } from "@everdict/contracts";

// The checkpoint body is the O6 contract minus what the control plane stamps: identity, clock and the
// attribution of whoever is calling. A caller naming its own id or authorship is a caller that can forge a
// predecessor, and the facts/hypotheses split is only worth anything if the byline is not one of the claims.
export const CreateCheckpointBodySchema = HandoffCheckpointSchema.omit({
  id: true,
  createdAt: true,
  createdBy: true,
});
