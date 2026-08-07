import { z } from "zod";

// POST /scorecards/gate — the CI-facing release gate over baseline↔candidate (A1).
export const GateScorecardsBodySchema = z.object({
  baseline: z.string().min(1),
  candidate: z.string().min(1),
  policy: z
    .object({
      maxRegressions: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type GateScorecardsBody = z.infer<typeof GateScorecardsBodySchema>;

// POST /scorecards/:id/gate/override — force a BLOCK through, with who and why recorded (B1).
export const OverrideGateBodySchema = z.object({
  decisionId: z.string().min(1),
  reason: z.string().min(1),
});
export type OverrideGateBody = z.infer<typeof OverrideGateBodySchema>;
