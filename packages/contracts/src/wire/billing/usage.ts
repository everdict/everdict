import { z } from "zod";

// GET /usage — the workspace's metered LLM usage (@everdict/billing TenantUsage). Meter-only: this
// never blocks; the billable surface is orchestration + verdict LLM cost (own-pays runs excluded).
const UsageTotalsSchema = z.object({
  usd: z.number(),
  tokens: z.number(),
  evaluations: z.number().describe("Metered case-evaluations (cases × trials that ran and were billable)"),
});

export const UsageResponseSchema = UsageTotalsSchema.extend({
  bySource: z
    .object({
      harness: UsageTotalsSchema.describe("The harness under test"),
      judge: UsageTotalsSchema.describe("The eval/judge model"),
    })
    .describe("Per-source breakdown of the totals"),
});
