import { HandoffCheckpointSchema } from "@everdict/contracts";
import { z } from "zod";

// The checkpoint body is the O6 contract minus what the control plane stamps: identity, clock and the
// attribution of whoever is calling. A caller naming its own id or authorship is a caller that can forge a
// predecessor, and the facts/hypotheses split is only worth anything if the byline is not one of the claims.
//
// `envelope` is the POLICY SLICE of the task envelope this checkpoint suspends. Envelopes are not persisted,
// so the rollbackRequired ⇒ rollbackPlan cross-invariant is enforceable only when the producer carries the
// policy in — and volunteering it can only make admission STRICTER (a checkpoint without a rollback plan is
// refused), never looser, which is why a caller-declared slice is safe here.
export const CreateCheckpointBodySchema = HandoffCheckpointSchema.omit({
  id: true,
  createdAt: true,
  createdBy: true,
}).extend({
  envelope: z.object({ id: z.string().min(1), rollbackRequired: z.boolean().optional() }).optional(),
});
