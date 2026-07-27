import { CapabilitySpecSchema } from "@everdict/contracts";
import { z } from "zod";

// POST /capabilities/validate body — a dry-run of an author save. Same fields the save path uses to decide the
// version (id + name + description + spec), minus reach (validation is reach-agnostic). Never writes.
export const ValidateCapabilityBodySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  spec: CapabilitySpecSchema,
});
