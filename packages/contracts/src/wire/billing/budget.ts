import { z } from "zod";

// GET/PUT /budget — committed usage + the per-tenant enforcement limit (@everdict/domain
// BudgetUsage/BudgetLimit). Distinct from the meter-only /usage: this budget blocks runs with 402 at a cap.
export const BudgetResponseSchema = z.object({
  usage: z.object({
    usd: z.number().describe("Committed cumulative cost"),
    tokens: z.number().describe("Committed cumulative tokens"),
    runs: z.number().describe("Admitted runs (including reservations)"),
  }),
  limit: z
    .object({
      usd: z.number().optional().describe("Cumulative cost cap (omitted = unlimited)"),
      tokens: z.number().optional().describe("Cumulative token cap (omitted = unlimited)"),
      runs: z.number().optional().describe("Cumulative run-count cap (omitted = unlimited)"),
    })
    .nullable()
    .describe("The per-tenant limit; null when no limit is set"),
});
export type BudgetResponse = z.infer<typeof BudgetResponseSchema>;
