import { z } from "zod";
import { EvalCaseSchema } from "./eval-case.js";

// 컨트롤플레인 → 러너 에이전트로 전달되는 한 건의 작업.
// 에이전트는 이것만 받아 runCase 를 끝까지 수행한다(피평가 하니스 + 케이스).
export const AgentJobSchema = z.object({
  evalCase: EvalCaseSchema,
  harness: z.object({ id: z.string(), version: z.string() }),
});
export type AgentJob = z.infer<typeof AgentJobSchema>;
