import { z } from "zod";

// GET /scorecards/diff — baseline↔candidate comparison (@everdict/suite ScorecardDiff, plus a TrialDiff
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
  significant: z.boolean().describe("|z| >= zThreshold"),
});

export const ScorecardDiffResponseSchema = z.object({
  baseline: z.string().describe("Baseline scorecard id"),
  candidate: z.string().describe("Candidate scorecard id"),
  metrics: z.array(
    z.object({ metric: z.string(), baselineMean: z.number(), candidateMean: z.number(), delta: z.number() }),
  ),
  regressions: z.array(CaseDeltaSchema),
  improvements: z.array(CaseDeltaSchema),
  trials: z
    .object({
      baseline: z.string(),
      candidate: z.string(),
      zThreshold: z.number(),
      cases: z.array(TrialCaseDeltaSchema),
      regressions: z.array(TrialCaseDeltaSchema).describe("Significant AND pass rate dropped"),
      improvements: z.array(TrialCaseDeltaSchema).describe("Significant AND pass rate rose"),
    })
    .optional()
    .describe("Statistical trial-based gate — present only when either side ran trials"),
});
