import { z } from "zod";

// 비용/토큰 — LLM 프록시(LiteLLM)에서 하니스 무관하게 균일 수집
export const CostSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type Cost = z.infer<typeof CostSchema>;

// 정규화 트레이스 — 모든 하니스 어댑터가 native 출력을 "이것"으로 변환한다.
// 모든 지표(과업성공/궤적/비용/지연)가 이 한 줄기에서 파생된다.
export const TraceEventSchema = z.discriminatedUnion("kind", [
  z.object({ t: z.number(), kind: z.literal("message"), role: z.enum(["user", "assistant"]), text: z.string() }),
  z.object({
    t: z.number(),
    kind: z.literal("llm_call"),
    model: z.string(),
    cost: CostSchema.optional(),
    latencyMs: z.number().optional(),
  }),
  z.object({ t: z.number(), kind: z.literal("tool_call"), id: z.string(), name: z.string(), args: z.unknown() }),
  z.object({ t: z.number(), kind: z.literal("tool_result"), id: z.string(), ok: z.boolean(), output: z.string() }),
  z.object({ t: z.number(), kind: z.literal("env_action"), action: z.string(), detail: z.unknown().optional() }),
  z.object({ t: z.number(), kind: z.literal("error"), message: z.string() }),
]);
export type TraceEvent = z.infer<typeof TraceEventSchema>;
