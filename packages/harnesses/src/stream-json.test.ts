import { describe, expect, it } from "vitest";
import { mapClaudeStreamJson } from "./stream-json.js";

describe("mapClaudeStreamJson — stream-json → normalized TraceEvent", () => {
  const clock = () => {
    let t = 0;
    return () => t++;
  };

  it("maps assistant text + tool_use + usage", () => {
    const next = clock();
    const events = mapClaudeStreamJson(
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          content: [
            { type: "text", text: "I'll fix it" },
            { type: "tool_use", id: "tu_1", name: "Edit", input: { path: "a.ts" } },
          ],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      },
      next,
    );
    expect(events.map((e) => e.kind)).toEqual(["message", "tool_call", "llm_call"]);
    const llm = events.find((e) => e.kind === "llm_call");
    expect(llm?.kind === "llm_call" && llm.cost?.inputTokens).toBe(10);
  });

  it("maps user tool_result and result (cost)", () => {
    const next = clock();
    const toolResult = mapClaudeStreamJson(
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }] },
      },
      next,
    );
    expect(toolResult[0]?.kind).toBe("tool_result");
    expect(toolResult[0]?.kind === "tool_result" && toolResult[0].ok).toBe(true);

    const result = mapClaudeStreamJson({ type: "result", total_cost_usd: 0.012 }, next);
    expect(result[0]?.kind === "llm_call" && result[0].cost?.usd).toBe(0.012);
  });
});
