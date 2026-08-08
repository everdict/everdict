import { z } from "zod";

// POST /scorecards/gate — the CI-facing release gate over baseline↔candidate (A1).
export const GateScorecardsBodySchema = z.object({
  baseline: z.string().min(1),
  candidate: z.string().min(1),
  // Every field is optional and only what the caller SENDS is embedded in the recorded decision — the
  // semantic defaults (maxRegressions 0, comparability "require_full") are applied downstream so an
  // already-recorded policy keeps its digest.
  policy: z
    .object({
      maxRegressions: z.number().int().nonnegative().optional(),
      comparability: z.enum(["require_full", "allow_partial"]).optional(),
      maxMissingCases: z.number().int().nonnegative().optional(),
      maxMissingFraction: z.number().min(0).max(1).optional(),
      maxUnmeasuredFraction: z.number().min(0).max(1).optional(),
      // Share of a metric's baseline measurement rate the candidate may lose (complete disappearance = 1.0).
      maxMetricLossFraction: z.number().min(0).max(1).optional(),
      // allow_partial only: accept kind-changed columns (same metric name, different value kind) deliberately.
      allowMetricKindChange: z.boolean().optional(),
      // Experiment-identity axes accepted as different (recorded on the decision): a verified confound on an
      // axis not listed refuses the pair as not_comparable — a different experiment, not a regression.
      allowConfounds: z.array(z.enum(["dataset_content", "grading_plan", "judge_set"])).optional(),
      // Accept UNVERIFIABLE identity (unsealed side / digest-era gap / pre-split composite seal) explicitly —
      // by default the gate refuses to issue green on an identity nobody can verify.
      allowUnverifiedIdentity: z.boolean().optional(),
      zThreshold: z.number().positive().optional(),
      minDelta: z.number().min(0).max(1).optional(),
      // Benjamini–Hochberg false-discovery level across the per-case trial tests. Absent = no correction.
      fdrAlpha: z.number().gt(0).lt(1).optional(),
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
