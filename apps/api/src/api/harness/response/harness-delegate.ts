import { DelegateResolutionSchema } from "@everdict/contracts";
import { z } from "zod";

// GET /harnesses/:id/delegate — the maintainer a slot's source names, resolved by the contracts predicate; the
// resolution shape is the contracts schema verbatim (one spelling, docs/architecture/evolution-routing-spec.md §1).
export const HarnessDelegateResponseSchema = z.object({
  harness: z.object({ id: z.string(), version: z.string() }),
  template: z.object({ id: z.string(), version: z.string() }),
  resolution: DelegateResolutionSchema,
});
