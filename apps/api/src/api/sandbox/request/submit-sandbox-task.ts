import { DelegateDeliveryModeSchema } from "@everdict/contracts";
import { z } from "zod";

// Submit one ad-hoc test case into a live harness session (the playground). No dataset, no graders — the
// prompt IS the case; the service clamps the timeout to its max. A busy delegate is no longer a refusal —
// `delivery` says whether to queue for the next boundary, start a turn, or interrupt the one in flight.
// On a CONVERSATION session each submit is one more turn of the same conversation; `fresh` starts a new
// thread (drops the resume state, keeps the workdir). 400 on a non-conversation session.
export const SubmitSandboxTaskBodySchema = z.object({
  task: z.string().min(1).max(20_000),
  timeoutSec: z.number().int().positive().max(3600).optional(), // default 600
  fresh: z.boolean().optional(),
  // What this does to the turn the delegate is in. Default `task`, which is what every caller meant before
  // the vocabulary existed. See `planDelivery` (@everdict/domain) for the decision itself.
  delivery: DelegateDeliveryModeSchema.optional(),
});
export type SubmitSandboxTaskBody = z.infer<typeof SubmitSandboxTaskBodySchema>;
