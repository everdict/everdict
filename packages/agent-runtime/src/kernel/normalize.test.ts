import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../messages.js";
import { SYNTHETIC_TOOL_RESULT, normalizeHistory } from "./normalize.js";

const call = (
  id: string,
  name = "get_run",
): NonNullable<Extract<ChatMessage, { role: "assistant" }>["tool_calls"]>[0] => ({
  id,
  type: "function" as const,
  function: { name, arguments: "{}" },
});

describe("normalizeHistory", () => {
  it("passes a balanced transcript through unchanged", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "ra" },
      { role: "tool", tool_call_id: "b", content: "rb" },
      { role: "assistant", content: "done" },
    ];
    expect(normalizeHistory(history)).toEqual(history);
  });

  it("repairs a crash-dangling assistant tool_call with a synthetic result so the conversation is not bricked", () => {
    // Given a transcript persisted up to the assistant's tool_calls when the host died (no results followed)
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      // …crash — then the user sends the next message into the same conversation
      { role: "user", content: "are you there?" },
    ];
    // When the history is replayed for the next model call
    const repaired = normalizeHistory(history);
    // Then every dangling call is answered with a synthetic result BEFORE the next user turn (provider-valid pairing)
    expect(repaired).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: SYNTHETIC_TOOL_RESULT },
      { role: "tool", tool_call_id: "b", content: SYNTHETIC_TOOL_RESULT },
      { role: "user", content: "are you there?" },
    ]);
  });

  it("fills in only the MISSING results when the crash landed between two tool results", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "ra" },
      // b's result was never persisted
    ];
    const repaired = normalizeHistory(history);
    expect(repaired[repaired.length - 1]).toEqual({
      role: "tool",
      tool_call_id: "b",
      content: SYNTHETIC_TOOL_RESULT,
    });
    // a's real result is untouched
    expect(repaired[2]).toEqual({ role: "tool", tool_call_id: "a", content: "ra" });
  });

  it("drops an orphan tool result that no assistant call is awaiting", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "tool", tool_call_id: "ghost", content: "orphan" },
      { role: "assistant", content: "hi" },
    ];
    expect(normalizeHistory(history)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("still drops degenerate empty assistant messages", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "real" },
    ];
    expect(normalizeHistory(history)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "real" },
    ]);
  });
});
