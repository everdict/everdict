import type { LlmTransport, StreamResult } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../messages.js";
import type { ToolDefinition } from "../tools/definition.js";
import { ToolRegistry } from "../tools/registry.js";
import { type AgentEvent, runAgentLoop } from "./loop.js";

// ── THE OUTCOME IS AVAILABLE BEFORE THE MESSAGE IS HANDED OVER, AND IT IS JOINABLE ───────────────────
//
// `ChatMessage` is the OpenAI protocol type and has nowhere to carry "did this call work", so a host that
// persists the transcript learns the outcome from the `tool_result` EVENT and joins it to the message by tool
// call id (apps/agent `chat.ts` → the row's `isError`, mig 0202). Two properties make that possible, and both
// live here rather than in the host:
//
//   ORDER — the event is emitted before the loop awaits `onMessage`. If it were the other way round the host's
//           map would be empty at persist time, and the feature would be inert with every test still green:
//           the field would simply be absent, which is a legal value.
//   KEY   — the event carries the tool call's id, the same one on the message's `tool_call_id`. An event with
//           no id, or a different one, misses the lookup and produces exactly the same silent absence.
//
// Written as a counterexample rather than left to the host's comment: the host asserts this about the kernel,
// which makes it a claim about another component, and rule `protocol` says the claim is the part that needs
// the test.

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function fakeTransport(results: StreamResult[]): LlmTransport {
  let call = 0;
  return {
    provider: "fake",
    stream: async () => {
      const r = results[call] ?? { content: null, toolCalls: [], finishReason: "stop" };
      call += 1;
      return r;
    },
  };
}

const failing: ToolDefinition = {
  name: "write_file",
  description: "write a file",
  parametersJsonSchema: { type: "object", properties: {} },
  call: async () => ({ content: "Permission denied.", isError: true }),
};

const succeeding: ToolDefinition = {
  name: "read_file",
  description: "read a file",
  parametersJsonSchema: { type: "object", properties: {} },
  isReadOnly: true,
  // Output that LOOKS like a failure and is not — the case the host's text reading got wrong, and the reason
  // the recorded flag has to travel at all.
  call: async () => ({ content: "Error: connection reset\nPermission denied: /etc/shadow", isError: false }),
};

describe("a tool result's outcome reaches the host before the message it belongs to", () => {
  it("emits tool_result with the call's id and outcome, then hands over the message", async () => {
    const order: string[] = [];
    const events: AgentEvent[] = [];
    const messages: ChatMessage[] = [];
    await runAgentLoop({
      transport: fakeTransport([
        {
          content: null,
          toolCalls: [
            { id: "c1", name: "write_file", arguments: "{}" },
            { id: "c2", name: "read_file", arguments: "{}" },
          ],
          finishReason: "tool_calls",
          usage,
        },
        { content: "done", toolCalls: [], finishReason: "stop", usage },
      ]),
      model: "m",
      systemPrompt: "s",
      history: [{ role: "user", content: "go" }],
      registry: new ToolRegistry([failing, succeeding]),
      onEvent: (e) => {
        events.push(e);
        if (e.type === "tool_result") order.push(`event:${e.id}`);
      },
      onMessage: (m) => {
        messages.push(m);
        if (m.role === "tool") order.push(`message:${m.tool_call_id}`);
      },
    });

    // Per call, and interleaved per call rather than batched: the event for c1 precedes c1's message, and the
    // same for c2. A host that persists as each message arrives needs the outcome for THAT call already in
    // hand, not merely somewhere in the stream.
    expect(order).toEqual(["event:c1", "message:c1", "event:c2", "message:c2"]);
  });

  it("carries the outcome the tool reported, joinable to the message by tool call id", async () => {
    const outcomes = new Map<string, boolean>();
    const toolMessages: ChatMessage[] = [];
    await runAgentLoop({
      transport: fakeTransport([
        {
          content: null,
          toolCalls: [
            { id: "c1", name: "write_file", arguments: "{}" },
            { id: "c2", name: "read_file", arguments: "{}" },
          ],
          finishReason: "tool_calls",
          usage,
        },
        { content: "done", toolCalls: [], finishReason: "stop", usage },
      ]),
      model: "m",
      systemPrompt: "s",
      history: [{ role: "user", content: "go" }],
      registry: new ToolRegistry([failing, succeeding]),
      // The host's exact move, reproduced: remember the outcome, then look it up when the message lands.
      onEvent: (e) => {
        if (e.type === "tool_result" && e.id !== undefined) outcomes.set(e.id, e.isError);
      },
      onMessage: (m) => {
        if (m.role === "tool") toolMessages.push(m);
      },
    });

    // Non-empty and the expected cardinality BEFORE asserting properties — an empty join is a join that
    // silently proved nothing.
    expect(toolMessages).toHaveLength(2);
    const joined = toolMessages.map((m) => ({
      id: m.role === "tool" ? m.tool_call_id : undefined,
      isError: m.role === "tool" ? outcomes.get(m.tool_call_id) : undefined,
    }));
    expect(joined).toEqual([
      { id: "c1", isError: true },
      // The one the text reading called a failure. The tool said it worked, and that is the fact.
      { id: "c2", isError: false },
    ]);
  });
});
