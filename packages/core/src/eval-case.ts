import { z } from "zod";
import { EnvSnapshotSchema, EnvSpecSchema } from "./environment.js";
import { ScoreSchema } from "./grader.js";
import { TraceEventSchema } from "./trace.js";

export const EvalCaseSchema = z.object({
  id: z.string(),
  env: EnvSpecSchema,
  task: z.string(),
  graders: z.array(z.string()), // grader id 참조
  image: z.string().optional(),
  timeoutSec: z.number().default(1800),
  tags: z.array(z.string()).default([]),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const CaseResultSchema = z.object({
  caseId: z.string(),
  harness: z.string(), // "claude-code@1.2.3"
  trace: z.array(TraceEventSchema),
  snapshot: EnvSnapshotSchema,
  scores: z.array(ScoreSchema),
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

export const ScorecardSchema = z.object({
  suiteId: z.string(),
  harness: z.string(),
  results: z.array(CaseResultSchema),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;
