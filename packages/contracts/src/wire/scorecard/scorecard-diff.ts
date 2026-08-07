import { z } from "zod";

// GET /scorecards/diff — baseline↔candidate comparison (@everdict/domain ScorecardDiff, plus a TrialDiff
// block when either side ran trials). Regressions/improvements are decided by objective pass transitions.
const CaseDeltaSchema = z.object({
  caseId: z.string(),
  metric: z.string(),
  baseline: z.number(),
  candidate: z.number(),
  delta: z.number().describe("candidate - baseline"),
  passChange: z.enum(["fixed", "broke"]).optional(),
});

const TrialCaseDeltaSchema = z.object({
  caseId: z.string(),
  baselineRate: z.number(),
  baselineTrials: z.number().int(),
  candidateRate: z.number(),
  candidateTrials: z.number().int(),
  delta: z.number().describe("candidateRate - baselineRate"),
  z: z.number().describe("Two-proportion z of candidate vs baseline (negative = candidate lower)"),
  method: z
    .enum(["z", "fisher"])
    .describe("Which test decided significance — small samples use Fisher's exact test, not the z approximation"),
  p: z
    .number()
    .describe("Two-sided p of this case's test — Fisher's exact p, or the normal-tail p of z on the z branch"),
  significant: z.boolean().describe("Statistically significant AND |delta| >= minDelta"),
  fdrSuppressed: z
    .boolean()
    .optional()
    .describe(
      "Cleared its own alpha but did not survive the Benjamini-Hochberg correction across the batch's cases — significant before correction, not after",
    ),
});

export const ScorecardDiffResponseSchema = z.object({
  baseline: z.string().describe("Baseline scorecard id"),
  candidate: z.string().describe("Candidate scorecard id"),
  metrics: z
    .array(
      z.object({
        metric: z.string(),
        baselineMean: z.number(),
        candidateMean: z.number(),
        delta: z.number(),
        direction: z.enum(["higher_is_better", "lower_is_better", "neutral"]).optional(),
        reading: z
          .enum(["improved", "regressed", "unchanged", "unknown"])
          .describe("The delta interpreted through the declared direction — never generalize delta>0 as improvement"),
      }),
    )
    .describe("Metrics present on BOTH sides only — one-sided metrics are enumerated in `missing`, never zero-filled"),
  regressions: z.array(CaseDeltaSchema),
  improvements: z.array(CaseDeltaSchema),
  missing: z
    .object({
      casesOnlyInBaseline: z.array(z.string()),
      casesOnlyInCandidate: z.array(z.string()),
      metricsOnlyInBaseline: z.array(z.string()),
      metricsOnlyInCandidate: z.array(z.string()),
    })
    .describe("What could NOT be compared — a first-class output, never a silent skip"),
  incomparable: z
    .array(z.object({ metric: z.string(), reason: z.literal("kind_changed") }))
    .describe(
      "Same-name metrics whose value KIND changed between the sides (categorical↔numeric) — excluded from metrics",
    ),
  overlap: z
    .object({
      sharedCases: z.number().int().nonnegative(),
      baselineCases: z.number().int().nonnegative(),
      candidateCases: z.number().int().nonnegative(),
    })
    .describe("The raw overlap the comparability level was judged from — threshold-minded gates read the numbers"),
  comparability: z
    .enum(["full", "partial", "none"])
    .describe(
      "Whether the comparison holds — 'none' is a different claim from 'no differences'; gates read this FIRST",
    ),
  policyMismatch: z
    .object({
      baseline: z.object({ id: z.string(), version: z.string(), digest: z.string() }),
      candidate: z.object({ id: z.string(), version: z.string(), digest: z.string() }),
    })
    .optional()
    .describe(
      "Set when the two batches were judged under different verdict-policy digests (comparability forced to 'none')",
    ),
  policyUnresolvable: z
    .object({
      baseline: z.object({ id: z.string(), version: z.string(), digest: z.string() }).optional(),
      candidate: z.object({ id: z.string(), version: z.string(), digest: z.string() }).optional(),
    })
    .optional()
    .describe(
      "Set when a side's STAMPED verdict policy could not be restored (comparability forced to 'none'): those verdicts cannot be re-derived, so the comparison stands on nothing — a gate must refuse rather than re-judge under today's ladder",
    ),
  trials: z
    .object({
      baseline: z.string(),
      candidate: z.string(),
      zThreshold: z.number(),
      minDelta: z
        .number()
        .describe("Practical-significance floor — significant drops smaller than this stay out of the gate"),
      fdrAlpha: z
        .number()
        .optional()
        .describe(
          "Benjamini-Hochberg false-discovery level applied across these cases' tests — absent means every case was gated at its own alpha",
        ),
      cases: z.array(TrialCaseDeltaSchema),
      regressions: z.array(TrialCaseDeltaSchema).describe("Significant AND pass rate dropped"),
      improvements: z.array(TrialCaseDeltaSchema).describe("Significant AND pass rate rose"),
      missing: z.object({
        casesOnlyInBaseline: z.array(z.string()),
        casesOnlyInCandidate: z.array(z.string()),
        unscoredCases: z.array(z.string()),
      }),
    })
    .optional()
    .describe("Statistical trial-based gate — present only when either side ran trials"),
});
export type ScorecardDiffResponse = z.infer<typeof ScorecardDiffResponseSchema>;
