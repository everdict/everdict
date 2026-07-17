import { describe, expect, it } from "vitest";
import { type Span, spansToSpanNodes } from "./trace-source.js";

describe("spansToSpanNodes — the waterfall the detail dialog renders", () => {
  it("derives offset/duration/type/model/tokens/cost/io from a span, offsets relative to the earliest span", () => {
    const spans: Span[] = [
      { name: "agent.run", spanId: "a", startMs: 1000, endMs: 4000, attrs: { "mlflow.spanType": "AGENT" } },
      {
        name: "llm.plan",
        spanId: "b",
        parentId: "a",
        startMs: 1100,
        endMs: 3200,
        attrs: {
          "gen_ai.request.model": "claude-opus-4-8",
          "gen_ai.usage.input_tokens": 3180,
          "gen_ai.usage.output_tokens": 922,
          "gen_ai.usage.cost": 0.03,
          "mlflow.spanInputs": { prompt: "plan it" },
          "output.value": "step 1",
        },
      },
    ];
    const nodes = spansToSpanNodes(spans);
    expect(nodes[0]).toMatchObject({ id: "a", name: "agent.run", type: "agent", startOffsetMs: 0, durationMs: 3000 });
    expect(nodes[1]).toMatchObject({
      id: "b",
      parentId: "a",
      type: "llm",
      startOffsetMs: 100, // relative to the earliest span (1000)
      durationMs: 2100,
      model: "claude-opus-4-8",
      tokens: { input: 3180, output: 922 },
      costUsd: 0.03,
      input: '{"prompt":"plan it"}', // an object I/O is JSON-stringified for display
      output: "step 1",
    });
  });

  it("classifies a tool span and falls back to a name-index id when the platform gives no span id", () => {
    const spans: Span[] = [{ name: "tool.web_search", startMs: 0, endMs: 700, attrs: { "tool.name": "web_search" } }];
    const nodes = spansToSpanNodes(spans);
    expect(nodes[0]).toMatchObject({ id: "tool.web_search-0", type: "tool", durationMs: 700 });
    expect(nodes[0]?.parentId).toBeUndefined();
  });

  it("returns [] for an empty span set (a native-kind trace with no spans)", () => {
    expect(spansToSpanNodes([])).toEqual([]);
  });
});
