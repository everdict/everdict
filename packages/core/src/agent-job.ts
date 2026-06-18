import { z } from "zod";
import { EvalCaseSchema } from "./eval-case.js";
import { HarnessSpecSchema } from "./harness-spec.js";

// 컨트롤플레인 → 러너 에이전트로 전달되는 한 건의 작업.
// 에이전트는 이것만 받아 runCase 를 끝까지 수행한다(피평가 하니스 + 케이스).
// tenant: SaaS 멀티테넌트 식별자 — 공정 스케줄링/쿼터/격리/정산의 키. 에이전트는 무시한다.
// harnessSpec: 컨트롤플레인이 레지스트리에서 풀어 임베드(선언형 command 하니스를 에이전트가 코드 없이 해석).
//   없으면 에이전트가 id 로 빌트인 어댑터(claude-code/scripted)를 만든다.
export const AgentJobSchema = z.object({
  evalCase: EvalCaseSchema,
  harness: z.object({ id: z.string(), version: z.string() }),
  harnessSpec: HarnessSpecSchema.optional(),
  tenant: z.string().optional(),
});
export type AgentJob = z.infer<typeof AgentJobSchema>;
