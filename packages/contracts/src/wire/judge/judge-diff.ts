import type { z } from "zod";
import { JudgeSpecDiffSchema } from "../../harness/judge-diff.js";

// GET /judges/:id/diff 200 — the structural diff of two judge versions. SSOT: @everdict/contracts JudgeSpecDiffSchema.
export const JudgeSpecDiffResponseSchema = JudgeSpecDiffSchema;
export type JudgeSpecDiffResponse = z.infer<typeof JudgeSpecDiffResponseSchema>;
