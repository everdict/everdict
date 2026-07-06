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
  // 채점 시 환경(compute)에서 명령을 실행하는 grader 는 true 로 선언(tests-pass/command 등 outcome 계열).
  // 미선언 = 관측물(trace/snapshot) 전용 → runCase 가 compute 를 해제한 뒤에 채점해 샌드박스 점유를
  // 실행 구간으로 최소화한다(judge LLM 대기 동안 미점유). docs/architecture/streaming-case-pipeline.md
  readonly needsCompute?: boolean;
  grade(ctx: GradeContext): Promise<Score>;
}
