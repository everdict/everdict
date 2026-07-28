import { describe, expect, it } from "vitest";
import { type AgentTryMessage, tryMessagesToTrace } from "./agent-try.js";

describe("tryMessagesToTrace", () => {
  it("projects a try transcript into an ingestable TraceEvent stream (event → messages → tool call/result pairs)", () => {
    // Given a shadow-try transcript with a tool round-trip and a final answer
    const messages: AgentTryMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "get_scorecard", arguments: '{"id":"sc-1"}' }],
      },
      { role: "tool", content: '{"status":"succeeded"}', toolCallId: "x" },
      { role: "assistant", content: "The batch succeeded; 2 cases failed on login." },
    ];

    // When normalizing
    const trace = tryMessagesToTrace({ kind: "scorecard.completed", message: "Scorecard sc-1 succeeded" }, messages);

    // Then the stream opens with the waking event and pairs the tool call with its result by id
    expect(trace[0]).toMatchObject({
      kind: "message",
      role: "user",
      text: "[scorecard.completed] Scorecard sc-1 succeeded",
    });
    const call = trace.find((e) => e.kind === "tool_call");
    const result = trace.find((e) => e.kind === "tool_result");
    expect(call).toMatchObject({ name: "get_scorecard", args: { id: "sc-1" } });
    expect(result).toMatchObject({ ok: true });
    expect(call && result && "id" in call && "id" in result && call.id === result.id).toBe(true);
    expect(trace.at(-1)).toMatchObject({ kind: "message", role: "assistant" });
  });
});
