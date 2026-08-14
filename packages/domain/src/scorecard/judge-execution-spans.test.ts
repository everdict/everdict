import type { TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { judgeExecutionSpans } from "./judge-execution-spans.js";

// Downstream report 1.1's trap: the judge's execution must be legible to a reader and INVISIBLE to the
// measurement plane — span kind, never llm_call, or the judge's tokens bill the judged agent.
describe("judgeExecutionSpans — the judgment plane in the vocabulary the measurement plane cannot misread", () => {
  const events: TraceEvent[] = [
    {
      t: 5,
      kind: "llm_call",
      model: "claude-opus-4-8",
      cost: { inputTokens: 900, outputTokens: 120, usd: 0.02 },
      latencyMs: 640,
    },
    { t: 6, kind: "message", role: "assistant", text: "PASS — the cart total matches." },
    { t: 7, kind: "span", name: "checkout", attributes: { step: 2 } },
    { t: 8, kind: "tool_call", id: "t1", name: "bash", args: {} },
  ];

  it("converts the model call and verdict to judge-named spans, renames structural spans, drops the transcript", () => {
    const spans = judgeExecutionSpans("quality", events);
    expect(spans.map((s) => s.kind)).toEqual(["span", "span", "span"]); // NOTHING is an llm_call
    expect(spans[0]).toMatchObject({
      kind: "span",
      name: "judge:quality:llm_call",
      attributes: { model: "claude-opus-4-8", inputTokens: 900, outputTokens: 120, usd: 0.02, latencyMs: 640 },
    });
    expect(spans[1]).toMatchObject({ name: "judge:quality:verdict" });
    // A dispatched judge's own span can never satisfy another judge's declared requires:[{kind:"span",name}].
    expect(spans[2]).toMatchObject({ name: "judge:quality:checkout" });
  });
});
