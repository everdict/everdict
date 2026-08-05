import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../messages.js";
import { SYNTHETIC_TOOL_RESULT, normalizeHistory, toWellFormedText, wellFormedArguments } from "./normalize.js";

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

  it("replays a persisted malformed tool_call arguments string as {} so the provider stops rejecting the conversation", () => {
    // Given a transcript persisted BEFORE creation-time normalization existed: the arguments were cut mid-JSON
    // (finish_reason length) and the turn even completed normally after the model saw the error tool result
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "a", type: "function" as const, function: { name: "get_run", arguments: '{"id": "r-' } }],
      },
      { role: "tool", tool_call_id: "a", content: "Invalid JSON arguments: Unexpected end of JSON input" },
      { role: "assistant", content: "sorry, let me retry" },
      { role: "user", content: "continue" },
    ];
    // When the history is replayed for the next model call
    const repaired = normalizeHistory(history);
    // Then the poisoned arguments are normalized at the send-time projection — the stored record is untouched,
    // but the wire never sees the fragment again (the conversation heals instead of staying bricked)
    expect(repaired[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "a", type: "function", function: { name: "get_run", arguments: "{}" } }],
    });
    // …and everything else replays verbatim
    expect(repaired[2]).toEqual(history[2]);
    expect(repaired[4]).toEqual(history[4]);
  });

  it("keeps well-formed tool_call arguments byte-identical when repairing", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function" as const, function: { name: "get_run", arguments: '{ "id": "r-1" }' } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "ok" },
    ];
    expect(normalizeHistory(history)).toEqual(history);
  });
});

describe("wellFormedArguments", () => {
  it("passes parseable JSON through byte-identical, whitespace included", () => {
    expect(wellFormedArguments('{ "path": "a.ts" }')).toBe('{ "path": "a.ts" }');
  });

  it("normalizes a truncated JSON fragment to {}", () => {
    expect(wellFormedArguments('{"path": "src/lo')).toBe("{}");
  });

  it("normalizes empty and prose arguments to {}", () => {
    expect(wellFormedArguments("")).toBe("{}");
    expect(wellFormedArguments("   ")).toBe("{}");
    expect(wellFormedArguments("I will read the file now")).toBe("{}");
  });

  it("repairs a lone surrogate inside otherwise-valid JSON in place instead of dropping the arguments", () => {
    expect(wellFormedArguments('{"text": "a\uD83D"}')).toBe('{"text": "a�"}');
  });
});

describe("toWellFormedText", () => {
  it("keeps intact surrogate pairs and replaces lone halves with U+FFFD", () => {
    expect(toWellFormedText("a😀b")).toBe("a😀b");
    expect(toWellFormedText("cut\uD83D")).toBe("cut�");
    expect(toWellFormedText("\uDE00tail")).toBe("�tail");
  });
});
