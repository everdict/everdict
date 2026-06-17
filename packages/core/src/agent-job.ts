import { z } from "zod";
import { EvalCaseSchema } from "./eval-case.js";

// 컨트롤플레인 → 러너 에이전트로 전달되는 한 건의 작업.
// 에이전트는 이것만 받아 runCase 를 끝까지 수행한다(피평가 하니스 + 케이스).
// tenant: SaaS 멀티테넌트 식별자 — 공정 스케줄링/쿼터/격리/정산의 키. 에이전트는 무시한다.
export const AgentJobSchema = z.object({
  evalCase: EvalCaseSchema,
  harness: z.object({ id: z.string(), version: z.string() }),
  tenant: z.string().optional(),
});
export type AgentJob = z.infer<typeof AgentJobSchema>;
