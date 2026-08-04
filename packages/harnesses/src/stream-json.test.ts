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

  // Regression: the mapper used to emit `t` alone. A reader that has only `t` has a scalar in an unstated unit,
  // so the trajectory could be drawn as a list and nothing else — no timeline (nothing says WHEN) and no tree
  // (nothing says what encloses what). Both now ride along, additively.
  it("stamps the absolute instant every event happened at", () => {
    const base = 1_700_000_000_000;
    const events = mapClaudeStreamJson(
      { type: "assistant", message: { model: "claude-opus-4-8", content: [{ type: "text", text: "hi" }] } },
      () => base,
    );
    expect(events[0]?.at).toBe(new Date(base).toISOString());
    expect(events[0]?.t).toBe(base); // `t` keeps its meaning — the latency grader reads its span
  });

  it("hangs a tool result under the call it answers, so the stream reads as the tree the CLI emitted", () => {
    const now = () => 1_700_000_000_000;
    const call = mapClaudeStreamJson(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_7", name: "Bash", input: { cmd: "ls" } }] },
      },
      now,
    );
    const result = mapClaudeStreamJson(
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_7", content: "ok" }] } },
      now,
    );

    expect(call[0]?.spanId).toBe("tu_7"); // the call IS the span
    expect(result[0]?.parentId).toBe("tu_7");
  });

  it("mints no span id for an anonymous call — two of them must not collapse into one node", () => {
    const events = mapClaudeStreamJson(
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } },
      () => 1_700_000_000_000,
    );
    expect(events[0]?.spanId).toBeUndefined();
  });
});
