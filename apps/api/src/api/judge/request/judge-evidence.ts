import { EnvSnapshotSchema, JudgeSpecSchema, TraceEventSchema } from "@everdict/contracts";
import { z } from "zod";

// The sample evidence a preview/dry-run judges over. All variants resolve to ONE GradeContext (case+trace+snapshot).
// S2 ships the "trace" (paste/upload) source; "run"/"scorecard"/"live" are added in S3 (real re-score + live dispatch).
export const JudgeEvidenceSchema = z.discriminatedUnion("source", [
  // Source B — the user provides a trace directly (pasted, or pulled out of their platform). No run needed.
  z.object({
    source: z.literal("trace"),
    trace: z.array(TraceEventSchema),
    task: z.string().optional(), // the task the agent was given (evidence context); defaults to a placeholder
    expected: z.string().optional(), // reference output, if any
    snapshot: EnvSnapshotSchema.optional(), // defaults to an empty prompt snapshot (environment-free)
  }),
]);
export type JudgeEvidence = z.infer<typeof JudgeEvidenceSchema>;

// Preview a judge (inline draft spec) against sample evidence — renders the exact prompt + coverage, NO model call.
export const PreviewJudgeBodySchema = z.object({
  spec: JudgeSpecSchema,
  evidence: JudgeEvidenceSchema,
});
export type PreviewJudgeBody = z.infer<typeof PreviewJudgeBodySchema>;
