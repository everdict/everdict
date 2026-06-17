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
  // 결과 그레이더는 환경에서 명령을 실행할 수 있다(process 하니스). service/browser 하니스엔 compute 가 없으므로 optional.
  compute?: ComputeHandle;
  baseline?: Scorecard; // 회귀 비교용
}

// 채점 — 하니스와 완전 분리. 같은 그레이더가 모든 하니스를 동일하게 채점 →
// 하니스/버전 간 공정 비교가 가능해진다.
export interface Grader {
  readonly id: string;
  grade(ctx: GradeContext): Promise<Score>;
}
