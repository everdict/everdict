import { z } from "zod";
import type { ComputeHandle } from "./compute.js";
import type { EnvSnapshot } from "./environment.js";
import type { EvalCase, Scorecard } from "./eval-case.js";
import type { TraceEvent } from "./trace.js";

export const ScoreSchema = z.object({
  graderId: z.string(),
  metric: z.string(),
  value: z.number(),
  pass: z.boolean().optional(),
  detail: z.unknown().optional(),
});
export type Score = z.infer<typeof ScoreSchema>;

export interface GradeContext {
  case: EvalCase;
  trace: TraceEvent[];
  snapshot: EnvSnapshot;
  // Outcome graders can run commands in the environment (process harness). Optional because service/browser harnesses have no compute.
  compute?: ComputeHandle;
  baseline?: Scorecard; // for regression comparison
}

// Scoring — fully separate from the harness. The same grader scores every harness identically →
// enabling fair comparison across harnesses/versions.
export interface Grader {
  readonly id: string;
  // A grader that runs commands in the environment (compute) at scoring time declares true (outcome-family: tests-pass/command etc.).
  // Undeclared = observation-only (trace/snapshot) → runCase scores it after releasing compute, minimizing sandbox occupancy to
  // the execution window (not held while waiting on the judge LLM). docs/architecture/streaming-case-pipeline.md
  readonly needsCompute?: boolean;
  grade(ctx: GradeContext): Promise<Score>;
}
