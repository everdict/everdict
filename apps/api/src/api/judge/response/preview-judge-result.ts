import { EvidenceRequirementSchema, ScoreSchema } from "@everdict/contracts";
import { z } from "zod";

// The zero-cost preview result — the exact judging prompt, per-placeholder evidence coverage, and warnings.
export const EvidenceCoverageSchema = z.object({
  present: z.boolean(),
  chars: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

// Coverage of the judge's declared `requires` against this run (present only when the judge declares requirements).
export const EvidenceAssessmentSchema = z.object({
  satisfied: z.array(EvidenceRequirementSchema),
  missing: z.array(EvidenceRequirementSchema),
  warnings: z.array(z.string()),
});

export const JudgePreviewResultSchema = z.object({
  kind: z.enum(["model", "harness", "code"]),
  prompt: z.string(),
  evidence: z.record(z.string(), EvidenceCoverageSchema),
  warnings: z.array(z.string()),
  requirements: EvidenceAssessmentSchema.optional(),
});
export type JudgePreviewResult = z.infer<typeof JudgePreviewResultSchema>;

// The dry-run result. model/harness → the real scores (one model call) plus the rendered prompt/coverage.
// code → runId of the REAL standalone run executing the wrapper job (watch/read the verdict via GET /runs/:id).
export const JudgeTryResultSchema = JudgePreviewResultSchema.extend({
  scores: z.array(ScoreSchema).optional(),
  runId: z.string().optional(),
});
export type JudgeTryResult = z.infer<typeof JudgeTryResultSchema>;
