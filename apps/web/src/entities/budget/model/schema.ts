import type { BudgetResponse as WireBudgetResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Client mirror of the control plane /budget response — the workspace enforcement budget (blocks runs with 402 at a
// cap; distinct from meter-only /usage). Each limit dimension is optional; an absent dimension = unlimited.
export const budgetLimitSchema = z.object({
  usd: z.number().optional(),
  tokens: z.number().optional(),
  runs: z.number().optional(),
})

export const budgetUsageSchema = z.object({
  usd: z.number(),
  tokens: z.number(),
  runs: z.number(),
})

// GET/PUT /budget → { usage, limit } (limit is null when none is configured).
export const budgetResponseSchema = z.object({
  usage: budgetUsageSchema,
  limit: budgetLimitSchema.nullable(),
})

// Drift guard — identical-shape entity ({usage, limit}), so the guard is bidirectional. A renamed/added dimension
// or a nullability change on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebBudgetResponse = z.infer<typeof budgetResponseSchema>
type _budgetFwd = AssertAssignable<WebBudgetResponse, WireBudgetResponse>
type _budgetBack = AssertAssignable<WireBudgetResponse, WebBudgetResponse>

// Exported names alias the contract type; the sub-shapes have no separate wire counterpart (inline on the
// response) so they are derived FROM the wire response to stay in sync.
export type BudgetResponse = WireBudgetResponse
export type BudgetUsage = WireBudgetResponse['usage']
export type BudgetLimit = NonNullable<WireBudgetResponse['limit']>

export type __budgetDriftGuard = [_budgetFwd, _budgetBack]
