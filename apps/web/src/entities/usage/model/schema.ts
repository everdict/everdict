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

// One (source × model) line of the itemized breakdown — how much a given activity spent on a given model.
export const usageItemSchema = usageTotalsSchema.extend({
  source: z.enum(['harness', 'judge', 'agent']),
  model: z.string(),
})

// One (day × source × model) line of the daily spend series — what the billing chart plots.
export const usageDayItemSchema = usageItemSchema.extend({
  day: z.string(), // UTC day, YYYY-MM-DD
})

export const tenantUsageSchema = usageTotalsSchema.extend({
  bySource: z.object({
    harness: usageTotalsSchema, // the harness under test
    judge: usageTotalsSchema, // the eval/judge model
    agent: usageTotalsSchema, // agent conversations
  }),
  items: z.array(usageItemSchema), // per (source × model) breakdown
  daily: z.array(usageDayItemSchema), // per (day × source × model) series, oldest first (legacy bucket excluded)
})

// Drift guard — identical-shape entity (totals + bySource + items), so the guard is bidirectional. A renamed/added
// total, a change to bySource, or a change to an item field on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebTenantUsage = z.infer<typeof tenantUsageSchema>
type _usageFwd = AssertAssignable<WebTenantUsage, UsageResponse>
type _usageBack = AssertAssignable<UsageResponse, WebTenantUsage>

// Exported names alias the contract type; UsageTotals/UsageItem have no separate wire counterpart (inline on the
// response) so they are derived FROM the wire response to stay in sync.
export type TenantUsage = UsageResponse
export type UsageTotals = UsageResponse['bySource']['harness']
export type UsageItem = UsageResponse['items'][number]
export type UsageDayItem = UsageResponse['daily'][number]

export type __usageDriftGuard = [_usageFwd, _usageBack]
