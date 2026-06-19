import { describe, expect, it } from "vitest";
import { type TraceEvent, usageFromTrace } from "./trace.js";

describe("usageFromTrace", () => {
  it("llm_call 의 토큰/비용을 합산하고 calls 를 센다", () => {
    const trace: TraceEvent[] = [
      { t: 0, kind: "message", role: "user", text: "hi" },
      { t: 1, kind: "llm_call", model: "m", cost: { inputTokens: 10, outputTokens: 4, usd: 0.01 } },
      { t: 2, kind: "tool_call", id: "x", name: "n", args: {} },
      { t: 3, kind: "llm_call", model: "m", cost: { inputTokens: 6, outputTokens: 2, usd: 0.02 } },
    ];
    expect(usageFromTrace(trace)).toEqual({
      promptTokens: 16,
      completionTokens: 6,
      totalTokens: 22,
      usd: 0.03,
      calls: 2,
    });
  });

  it("cost 없는 llm_call 은 calls 만 세고 토큰/비용은 0", () => {
    const trace: TraceEvent[] = [{ t: 0, kind: "llm_call", model: "m" }];
    expect(usageFromTrace(trace)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      usd: 0,
      calls: 1,
    });
  });

  it("llm_call 이 없으면 전부 0", () => {
    expect(usageFromTrace([{ t: 0, kind: "message", role: "assistant", text: "x" }])).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      usd: 0,
      calls: 0,
    });
  });
});
