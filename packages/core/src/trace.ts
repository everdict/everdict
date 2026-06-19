import { z } from "zod";

// 비용/토큰 — 하니스가 자기 트레이스에 보고하는 값(예: Claude 의 total_cost_usd).
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

// 한 run 의 사용량 요약 — 트레이스의 llm_call 비용을 합산한 것(클라이언트가 트레이스를 파싱하지 않게 명시 노출).
export const RunUsageSummarySchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  calls: z.number().int().nonnegative(), // llm_call 이벤트 수
});
export type RunUsageSummary = z.infer<typeof RunUsageSummarySchema>;

// 트레이스 → 사용량 요약(파생). calls 는 모든 llm_call, 토큰/비용은 cost 가 있는 것만 합산.
export function usageFromTrace(trace: TraceEvent[]): RunUsageSummary {
  let promptTokens = 0;
  let completionTokens = 0;
  let usd = 0;
  let calls = 0;
  for (const e of trace) {
    if (e.kind !== "llm_call") continue;
    calls += 1;
    if (e.cost) {
      promptTokens += e.cost.inputTokens;
      completionTokens += e.cost.outputTokens;
      usd += e.cost.usd;
    }
  }
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, usd, calls };
}
