import { z } from "zod";
import { ScorecardOutcomesSchema } from "./scorecard.js";

// Workspace ops report — the SLA-evidence read (metrics commercialization C1): a workspace's own execution
// health over a window, derived from ITS OWN ledger only ("our fault vs the harness's fault", separated).
// Honesty rules carried from the trust kernel: every rate is ABSENT when its denominator is zero — a report
// with no executed cases has no infra-failure rate, not a 0% one.
export const OpsReportSchema = z.object({
  // The window actually reported (echoed request bounds; absent = unbounded on that side).
  from: z.string().optional(),
  to: z.string().optional(),
  batches: z.object({
    total: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    superseded: z.number().int().nonnegative(),
  }),
  // Case-fate sums across the window's batches — the same closed vocabulary scorecardOutcomes serves per batch.
  cases: ScorecardOutcomesSchema,
  rates: z.object({
    // infraFailed / executed — the platform's share of the window's failures.
    infraFailure: z.number().optional(),
    // unmeasured / gradeable — the scoring plane's outage share.
    unmeasured: z.number().optional(),
    // trace=complete / executed — evidence seal coverage (catalog P8).
    traceComplete: z.number().optional(),
  }),
  // Evidence-plane tallies across all executed cases (trust-kernel contract ⑤ vocabulary).
  evidence: z.object({
    trace: z.object({
      complete: z.number().int().nonnegative(),
      partial: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
      deferred: z.number().int().nonnegative(),
    }),
    snapshot: z.object({
      complete: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
    }),
  }),
});
export type OpsReport = z.infer<typeof OpsReportSchema>;
