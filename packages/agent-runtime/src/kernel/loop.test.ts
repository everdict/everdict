import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../messages.js";
import type { ToolDefinition } from "../tools/definition.js";
import { ToolRegistry } from "../tools/registry.js";
import { runAgentLoop } from "./loop.js";

interface FakeChunk {
  choices: {
    delta: {
      content?: string;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason: string | null;
  }[];
  usage?: { total_tokens: number };
}

// A fake OpenAI whose chat.completions.create returns a pre-scripted async stream per successive call, so the
// loop can be driven deterministically without a network provider.
function fakeClient(responses: FakeChunk[][]): OpenAI {
  let call = 0;
  const create = (): AsyncGenerator<FakeChunk> => {
    const chunks = responses[call] ?? [];
    call += 1;
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  };
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

const usageEnd: FakeChunk = { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 7 } };

function textResponse(text: string): FakeChunk[] {
  return [{ choices: [{ delta: { content: text }, finish_reason: null }] }, usageEnd];
}

function toolCallResponse(id: string, name: string, args: string): FakeChunk[] {
  return [
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] }, finish_reason: "tool_calls" },
      ],
    },
    usageEnd,
  ];
}

const history: ChatMessage[] = [{ role: "user", content: "hello" }];

describe("runAgentLoop", () => {
  it("stops with end_turn when the model returns text and no tool calls", async () => {
    const client = fakeClient([textResponse("Hi there")]);
    const result = await runAgentLoop({
      client,
      model: "test-model",
      systemPrompt: "You are a test agent.",
      history,
      registry: new ToolRegistry([]),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("Hi there");
    expect(result.turns).toBe(1);
    expect(result.toolCalls).toHaveLength(0);
  });

  it("dispatches a tool call, feeds the result back, then finishes", async () => {
    const call = vi.fn(async (input: unknown) => ({ content: `echo:${JSON.stringify(input)}`, isError: false }));
    const echo: ToolDefinition = {
      name: "echo",
      description: "echo the input",
      parametersJsonSchema: { type: "object", properties: { x: { type: "number" } } },
      isReadOnly: true,
      call,
    };
    const client = fakeClient([toolCallResponse("call_1", "echo", '{"x":1}'), textResponse("done")]);
    const seen: ChatMessage[] = [];
    const result = await runAgentLoop({
      client,
      model: "test-model",
      systemPrompt: "You are a test agent.",
      history,
      registry: new ToolRegistry([echo]),
      onMessage: (m) => {
        seen.push(m);
      },
    });
    expect(call).toHaveBeenCalledWith({ x: 1 }, expect.objectContaining({ selectedModel: "test-model" }));
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("done");
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toEqual([{ name: "echo", ok: true }]);
    // The produced transcript pairs the assistant tool_call with its tool result.
    const roles = result.produced.map((m) => m.role);
    expect(roles).toEqual(["assistant", "tool", "assistant"]);
    // produced is accumulated as messages are appended (== what onMessage saw), not a tail slice of the context.
    expect(result.produced).toEqual(seen);
    // A tool-only assistant turn carries null content (not "") alongside tool_calls.
    const first = result.produced[0] as { content: unknown; tool_calls?: unknown[] };
    expect(first.content).toBeNull();
    expect(first.tool_calls).toHaveLength(1);
  });

  it("records a failed tool call without breaking the loop", async () => {
    const client = fakeClient([toolCallResponse("call_1", "missing_tool", "{}"), textResponse("recovered")]);
    const result = await runAgentLoop({
      client,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
    });
    expect(result.toolCalls).toEqual([{ name: "missing_tool", ok: false }]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("recovered");
  });

  it("stops with aborted when the signal is already aborted", async () => {
    const client = fakeClient([textResponse("unused")]);
    const result = await runAgentLoop({
      client,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      signal: AbortSignal.abort(),
    });
    expect(result.stopReason).toBe("aborted");
    expect(result.turns).toBe(0);
  });
});
