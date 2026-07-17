import { EnvSnapshotSchema, JudgeSpecSchema, TraceEventSchema, TraceEvidenceSchema } from "@everdict/contracts";
import { z } from "zod";

// The sample evidence a preview/dry-run judges over. All variants resolve to ONE GradeContext (case+trace+snapshot).
// Source B (paste) needs no run; source "run" (A) re-scores a real prior standalone run's stored trace+snapshot.
// A live round-trip is POST /runs (real dispatch) → try with source "run" — no redundant synchronous dispatch path.
export const JudgeEvidenceSchema = z.discriminatedUnion("source", [
  // Source B — the user provides a trace directly (pasted, or pulled out of their platform). No run needed.
  z.object({
    source: z.literal("trace"),
    trace: z.array(TraceEventSchema),
    task: z.string().optional(), // the task the agent was given (evidence context); defaults to a placeholder
    expected: z.string().optional(), // reference output, if any
    snapshot: EnvSnapshotSchema.optional(), // defaults to an empty prompt snapshot (environment-free)
    traceEvidence: TraceEvidenceSchema.optional(), // extracted mapping evidence — carries CUSTOM slots into the preview
  }),
  // Source A — re-score a real prior run: its stored trace + snapshot + submitted EvalCase (the honest default).
  z.object({
    source: z.literal("run"),
    runId: z.string(),
  }),
]);
export type JudgeEvidence = z.infer<typeof JudgeEvidenceSchema>;

// Preview a judge (inline draft spec) against sample evidence — renders the exact prompt + coverage, NO model call.
export const PreviewJudgeBodySchema = z.object({
  spec: JudgeSpecSchema,
  evidence: JudgeEvidenceSchema,
});
export type PreviewJudgeBody = z.infer<typeof PreviewJudgeBodySchema>;

// Dry-run a judge (inline draft spec) against sample evidence — ACTUALLY runs the judge (one model call), one case.
export const TryJudgeBodySchema = z.object({
  spec: JudgeSpecSchema,
  evidence: JudgeEvidenceSchema,
});
export type TryJudgeBody = z.infer<typeof TryJudgeBodySchema>;
