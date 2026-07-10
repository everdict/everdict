import { z } from "zod";

// GET/PUT /internal/scheduling — the effective per-tenant fairness dials (overrides layered over env defaults).
export const SchedulingDialsResponseSchema = z.object({
  quotas: z.record(z.number()).describe("Effective per-tenant in-flight quotas"),
  weights: z.record(z.number()).describe("Effective per-tenant WFQ weights"),
});
