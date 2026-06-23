import { z } from "zod";
import { EvalCaseSchema } from "./eval-case.js";
import { HarnessSpecSchema } from "./harness-spec.js";

// per-run judge 모델 설정(시크릿 아님). 컨트롤플레인이 워크스페이스/스위트 정책으로 결정해 잡에 싣는다.
// inline judge grader(예: WebVoyager 프리셋)가 dispatch 경로에서 이 모델로 판정된다. 프로바이더 '키'는 시크릿(secretEnv).
export const JudgeRunConfigSchema = z.object({
  provider: z.enum(["openai", "anthropic"]).optional(),
  model: z.string(),
});
export type JudgeRunConfig = z.infer<typeof JudgeRunConfigSchema>;

// judge 모델 설정 ↔ env 의 계약(에이전트 judgeFromEnv 가 읽고, 컨트롤플레인/백엔드가 alloc 에 주입하는 키 이름).
export const JUDGE_MODEL_ENV = "ASSAY_JUDGE_MODEL";
export const JUDGE_PROVIDER_ENV = "ASSAY_JUDGE_PROVIDER";

// JudgeRunConfig → env 맵. 미설정이면 빈 맵(judge 비활성). 키 자체는 secretEnv 가 별도로 주입.
export function judgeEnv(j?: JudgeRunConfig): Record<string, string> {
  if (!j) return {};
  return { [JUDGE_MODEL_ENV]: j.model, ...(j.provider ? { [JUDGE_PROVIDER_ENV]: j.provider } : {}) };
}

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
  // 사용량 계측 여부 — 컨트롤플레인이 워크스페이스/요청 정책으로 결정해 잡에 실어 보낸다(글로벌 플래그 대체).
  // 에이전트는 이 값을 우선한다(미지정이면 dev 폴백으로 ASSAY_METER_USAGE env). command 하니스에서만 의미.
  meterUsage: z.boolean().optional(),
  // per-run judge 모델 설정 — evalCase 에 inline judge grader 가 있을 때 어떤 모델로 판정할지(시크릿 아님).
  // 백엔드가 alloc env(ASSAY_JUDGE_MODEL/PROVIDER)로 주입, 프로바이더 키는 secretEnv. 미설정이면 judge 는 skip.
  judge: JudgeRunConfigSchema.optional(),
  // 비공개 repo clone 용 transient 자격증명 — 컨트롤플레인이 evalCase.env.source.connectionId 를 외부 계정 연결
  // (Connected accounts)의 토큰으로 resolve 해 실어 보낸다. RepoEnvironment 가 인증 clone(http.extraheader)에만 쓰고,
  // RunRecord/데이터셋엔 저장되지 않는다(케이스엔 connectionId 참조만 남는다).
  repoToken: z.string().optional(),
});
export type AgentJob = z.infer<typeof AgentJobSchema>;
