import { z } from "zod";

// Cross-batch flake index (metrics commercialization A2, catalog T3/T9) — the served shape of
// @everdict/domain's flakeIndex. Advisory only: nothing is auto-quarantined.
export const FlakeEntrySchema = z.object({
  caseId: z.string(),
  harness: z.string(), // id@version
  runtime: z.string().optional(),
  observations: z.number().int().nonnegative(), // verdicted observations only — outages are not observations
  passes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  // min(p, 1−p) × 2 ∈ [0, 1]: 0 = perfectly stable, 1 = a coin. Meaningful with observations >= 2.
  flakeScore: z.number(),
});
export type FlakeEntry = z.infer<typeof FlakeEntrySchema>;

export const FlakeIndexSchema = z.object({
  entries: z.array(FlakeEntrySchema), // flaky keys only (both outcomes observed), most unstable first
  observedKeys: z.number().int().nonnegative(), // keys with >= 2 verdicted observations at all
});
export type FlakeIndex = z.infer<typeof FlakeIndexSchema>;
