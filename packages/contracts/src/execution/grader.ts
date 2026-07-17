import { z } from "zod";
import type { ComputeHandle, ComputeSpec } from "./compute.js";
import type { EnvSnapshot } from "./environment.js";
import type { EvalCase, Scorecard } from "./eval-case.js";
import type { TraceEvidence } from "./trace-source.js";
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
  // Evidence extracted from a pulled trace via the mapping's evidence slots — carries the CUSTOM named slots a
  // judge's promptTemplate references ({<name>}); the fixed slots already ride the snapshot/trace. Optional:
  // live-run paths without a mapping leave it unset.
  evidence?: TraceEvidence;
  // Outcome graders can run commands in the environment (process harness). Optional because service/browser harnesses have no compute.
  compute?: ComputeHandle;
  // Provision a DEDICATED grading compute (script grader `image` mode) — injected by runCase from its driver.
  // Optional: scoring paths without a driver (control-plane collect, topology) leave it unset. The grader that
  // provisions OWNS the handle and MUST dispose it in a finally.
  provision?: (spec: ComputeSpec) => Promise<ComputeHandle>;
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
  // One Score for most graders; a multi-metric grader (multi-criteria judge, script) returns several from ONE
  // evaluation pass — each Score's `metric` label stays the aggregation axis. docs/architecture/eval-domain-model.md
  grade(ctx: GradeContext): Promise<Score | Score[]>;
}

// Normalize a grader result at the collection points (runCase / service backends / judge runner).
export function toScores(result: Score | Score[]): Score[] {
  return Array.isArray(result) ? result : [result];
}
