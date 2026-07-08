import { z } from 'zod'

// Client mirror of the control-plane TenantUsage (GET /usage) — metered LLM cost for the billable surface
// (orchestration + verdict), split by source. Own-pays (self-hosted personal) runs are excluded server-side.
export const usageTotalsSchema = z.object({
  usd: z.number(),
  tokens: z.number(),
  evaluations: z.number(),
})
export type UsageTotals = z.infer<typeof usageTotalsSchema>

export const tenantUsageSchema = usageTotalsSchema.extend({
  bySource: z.object({
    harness: usageTotalsSchema, // the harness under test
    judge: usageTotalsSchema, // the eval/judge model
  }),
})
export type TenantUsage = z.infer<typeof tenantUsageSchema>
