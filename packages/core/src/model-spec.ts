import { z } from "zod";

// Model — 테넌트가 등록하는 1급 모델 정의("무엇으로 추론/판정하나"). 등록·버전·tenant 소유는 harness/judge/runtime 와
// 동일한 불변 버전 SSOT 패턴. judge·harness 가 raw 문자열 대신 등록된 model 을 id 로 참조 → provider/baseUrl/하부모델을
// 런타임에 해석. 평가 결과의 "어떤 모델로 돌렸나"가 비교 가능한 1급 대상이 된다.
// ⚠️ 비밀 금지 — API 키는 테넌트 SecretStore 에서 provider 별로 주입(ANTHROPIC_API_KEY/OPENAI_API_KEY). 여긴 비-비밀
// 연결정보만: provider, model(하부 식별자), baseUrl(OpenAI-호환 프록시=LiteLLM 등, 선택), params(샘플링 기본값).
export const ModelSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  model: z.string(), // 하부 모델 식별자(예: "claude-opus-4-8", "gpt-5.4-mini")
  baseUrl: z.string().url().optional(), // OpenAI/Anthropic-호환 프록시 베이스(LiteLLM 등). 비-비밀.
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
  tags: z.array(z.string()).default([]),
});
export type ModelSpec = z.infer<typeof ModelSpecSchema>;
