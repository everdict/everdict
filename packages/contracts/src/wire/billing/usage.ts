import { z } from "zod";

// GET /usage — the workspace's metered LLM usage (@everdict/domain TenantUsage). Meter-only: this
// never blocks; the billable surface is orchestration + verdict LLM cost (own-pays runs excluded).
const UsageTotalsSchema = z.object({
  usd: z.number(),
  tokens: z.number(),
  evaluations: z.number().describe("Metered case-evaluations (cases × trials that ran and were billable)"),
});

// One (source × model) line of the itemized breakdown — how much a given activity spent on a given model.
const UsageItemSchema = UsageTotalsSchema.extend({
  source: z.enum(["harness", "judge", "agent"]).describe("The activity that incurred the cost"),
  model: z.string().describe("The underlying model billed against ('' = legacy/unattributed)"),
});

// One (day × source × model) line of the daily spend series (the billing chart's data).
const UsageDayItemSchema = UsageItemSchema.extend({
  day: z.string().describe("UTC day (YYYY-MM-DD) the cost landed on"),
});

export const UsageResponseSchema = UsageTotalsSchema.extend({
  bySource: z
    .object({
      harness: UsageTotalsSchema.describe("The harness under test"),
      judge: UsageTotalsSchema.describe("The eval/judge model"),
      agent: UsageTotalsSchema.describe("Agent conversations"),
    })
    .describe("Per-source breakdown of the totals"),
  items: z.array(UsageItemSchema).describe("Per (source × model) breakdown of the totals"),
  daily: z
    .array(UsageDayItemSchema)
    .describe(
      "Per (day × source × model) spend series, oldest day first. Usage accumulated before daily itemization " +
        "is included in the totals/items but not here.",
    ),
});
export type UsageResponse = z.infer<typeof UsageResponseSchema>;
