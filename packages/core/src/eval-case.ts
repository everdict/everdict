import { z } from "zod";
import { EnvSnapshotSchema, EnvSpecSchema } from "./environment.js";
import { ScoreSchema } from "./grader.js";
import { TraceEventSchema } from "./trace.js";

// 그레이더 지정: id + 선택적 config (예: tests-pass 의 { cmd }).
// 에이전트가 이 스펙으로부터 Grader 인스턴스를 재구성한다.
export const GraderSpecSchema = z.object({
  id: z.string(),
  config: z.record(z.unknown()).optional(),
});
export type GraderSpec = z.infer<typeof GraderSpecSchema>;

export const EvalCaseSchema = z.object({
  id: z.string(),
  env: EnvSpecSchema,
  task: z.string(),
  graders: z.array(GraderSpecSchema),
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
