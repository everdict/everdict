import { ScoreSchema } from "@everdict/contracts";
import { z } from "zod";

// The zero-cost preview result — the exact judging prompt, per-placeholder evidence coverage, and warnings.
export const EvidenceCoverageSchema = z.object({
  present: z.boolean(),
  chars: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const JudgePreviewResultSchema = z.object({
  kind: z.enum(["model", "harness"]),
  prompt: z.string(),
  evidence: z.record(z.string(), EvidenceCoverageSchema),
  warnings: z.array(z.string()),
});
export type JudgePreviewResult = z.infer<typeof JudgePreviewResultSchema>;

// The dry-run result — the real judge scores (one model call) plus the rendered prompt/coverage for transparency.
export const JudgeTryResultSchema = JudgePreviewResultSchema.extend({
  scores: z.array(ScoreSchema),
});
export type JudgeTryResult = z.infer<typeof JudgeTryResultSchema>;
