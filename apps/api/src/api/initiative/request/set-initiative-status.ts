import { InitiativeStatusSchema } from "@everdict/contracts";
import { z } from "zod";

// One endpoint for every workflow move; the domain decides which transitions are legal from the current state.
export const SetInitiativeStatusBodySchema = z.object({
  status: InitiativeStatusSchema,
  // Completing is a gate — refused while any issue under any of the initiative's projects is open. Closing a
  // goal with known gaps is allowed, but only as an explicit, recorded override.
  force: z.boolean().optional(),
});
