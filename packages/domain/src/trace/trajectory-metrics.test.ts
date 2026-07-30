import type { TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { trajectoryMetricValue, trajectoryMetrics } from "./trajectory-metrics.js";

const trace: TraceEvent[] = [
  { t: 0, kind: "message", role: "user", text: "go" },
  { t: 1, kind: "llm_call", model: "m", cost: { inputTokens: 100, outputTokens: 50, usd: 0.02 }, latencyMs: 900 },
  { t: 2, kind: "tool_call", id: "c1", name: "bash", args: {} },
  { t: 3, kind: "tool_result", id: "c1", ok: false, output: "boom" },
  { t: 4, kind: "llm_call", model: "m", cost: { inputTokens: 10, outputTokens: 5, usd: 0.005 }, latencyMs: 300 },
  { t: 5, kind: "tool_call", id: "c2", name: "bash", args: {} },
  { t: 6, kind: "tool_result", id: "c2", ok: true, output: "ok" },
];

describe("trajectoryMetrics — the sealed trajectory's derived numbers (E4 perception)", () => {
  it("derives economics, tool counts, failures, and max latency in one pass", () => {
    expect(trajectoryMetrics(trace)).toEqual({
      usd: 0.025,
      totalTokens: 165,
      llmCalls: 2,
      toolCalls: 2,
      toolFailures: 1,
      events: 7,
      latencyMsMax: 900,
    });
  });

  it("maps every threshold metric key to its value — an unknown key is undefined, never zero", () => {
    const metrics = trajectoryMetrics(trace);
    expect(trajectoryMetricValue(metrics, "usd")).toBe(0.025);
    expect(trajectoryMetricValue(metrics, "tool_failures")).toBe(1);
    expect(trajectoryMetricValue(metrics, "latency_ms_max")).toBe(900);
    expect(trajectoryMetricValue(metrics, "nope")).toBeUndefined();
  });
});
