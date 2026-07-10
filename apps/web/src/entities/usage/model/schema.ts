import type { UsageResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Client mirror of the control-plane TenantUsage (GET /usage) — metered LLM cost for the billable surface
// (orchestration + verdict), split by source. Own-pays (self-hosted personal) runs are excluded server-side.
export const usageTotalsSchema = z.object({
  usd: z.number(),
  tokens: z.number(),
  evaluations: z.number(),
})

export const tenantUsageSchema = usageTotalsSchema.extend({
  bySource: z.object({
    harness: usageTotalsSchema, // the harness under test
    judge: usageTotalsSchema, // the eval/judge model
  }),
})

// Drift guard — identical-shape entity (totals + bySource), so the guard is bidirectional. A renamed/added
// total or a change to bySource on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebTenantUsage = z.infer<typeof tenantUsageSchema>
type _usageFwd = AssertAssignable<WebTenantUsage, UsageResponse>
type _usageBack = AssertAssignable<UsageResponse, WebTenantUsage>

// Exported names alias the contract type; UsageTotals has no separate wire counterpart (inline on the
// response) so it is derived FROM the wire response to stay in sync.
export type TenantUsage = UsageResponse
export type UsageTotals = UsageResponse['bySource']['harness']

export type __usageDriftGuard = [_usageFwd, _usageBack]
