import { z } from "zod";

// Agent Judge — 등록 가능한 1급 엔티티(소유/버전/lifecycle 은 하니스·데이터셋과 동일 패턴).
// 두 형태: model(LLM/VLM 직접 호출 함수) | harness(등록된 하니스 에이전트에 판정 위임).
// 실행은 컨트롤플레인이 트레이스 기반으로 한다(다음 증분) — 이 계약은 "무엇으로 판정하나"만 선언한다.

// 판정 입력 모달리티 — 무엇을 보고 판정하는가(trace=실행기록, dom/screenshot=브라우저 결과 → VLM).
export const JudgeInputSchema = z.enum(["trace", "dom", "screenshot"]);
export type JudgeInput = z.infer<typeof JudgeInputSchema>;

// model judge: LLM/VLM 를 직접 호출. rubric(기준) + 입력 모달리티로 판정 → {pass, score, reason}.
export const ModelJudgeSpecSchema = z.object({
  kind: z.literal("model"),
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  model: z.string(), // 예: "claude-opus-4-8"
  rubric: z.string(), // 판정 기준(프롬프트)
  inputs: z.array(JudgeInputSchema).default(["trace"]),
  passThreshold: z.number().min(0).max(1).optional(), // score→pass 임계값(없으면 모델이 pass 직접 판정)
  tags: z.array(z.string()).default([]),
});
export type ModelJudgeSpec = z.infer<typeof ModelJudgeSpecSchema>;

// harness judge: 등록된 하니스(에이전트)에 판정을 위임. version 은 실행 시 해석(latest 가능).
export const HarnessJudgeSpecSchema = z.object({
  kind: z.literal("harness"),
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  harness: z.object({ id: z.string(), version: z.string() }),
  rubric: z.string().optional(),
  // 판정 에이전트를 띄울 테넌트 Runtime id(placement.target 으로 라우팅). 없으면 산출 run 과 co-locate
  // (관측물을 만든 run 의 placement 를 상속). 미등록 런타임이면 디스패치가 visible skip 으로 떨어진다.
  runtime: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type HarnessJudgeSpec = z.infer<typeof HarnessJudgeSpecSchema>;

export const JudgeSpecSchema = z.discriminatedUnion("kind", [ModelJudgeSpecSchema, HarnessJudgeSpecSchema]);
export type JudgeSpec = z.infer<typeof JudgeSpecSchema>;
