import { z } from 'zod'

// Client mirror of the control plane /budget response — the workspace enforcement budget (blocks runs with 402 at a
// cap; distinct from meter-only /usage). Each limit dimension is optional; an absent dimension = unlimited.
export const budgetLimitSchema = z.object({
  usd: z.number().optional(),
  tokens: z.number().optional(),
  runs: z.number().optional(),
})
export type BudgetLimit = z.infer<typeof budgetLimitSchema>

export const budgetUsageSchema = z.object({
  usd: z.number(),
  tokens: z.number(),
  runs: z.number(),
})
export type BudgetUsage = z.infer<typeof budgetUsageSchema>

// GET/PUT /budget → { usage, limit } (limit is null when none is configured).
export const budgetResponseSchema = z.object({
  usage: budgetUsageSchema,
  limit: budgetLimitSchema.nullable(),
})
export type BudgetResponse = z.infer<typeof budgetResponseSchema>
