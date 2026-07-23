import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../messages.js";
import type { ToolDefinition } from "../tools/definition.js";
import { ToolRegistry } from "../tools/registry.js";
import { type AgentEvent, runAgentLoop } from "./loop.js";

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

  it("runs the compaction ladder when over the token budget (microcompact clears old tool results)", async () => {
    const big = "R".repeat(600);
    const longHistory: ChatMessage[] = [{ role: "user", content: "goal" }];
    for (let i = 0; i < 5; i++) {
      longHistory.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: `h${i}`, type: "function", function: { name: "noop", arguments: "{}" } }],
      });
      longHistory.push({ role: "tool", tool_call_id: `h${i}`, content: big });
    }
    longHistory.push({ role: "user", content: "continue" });

    const noop: ToolDefinition = {
      name: "noop",
      description: "noop",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: async () => ({ content: "ok", isError: false }),
    };
    // turn 1: a tool call whose usage pushes past 90% of 900k → compaction after dispatch; turn 2: text → end_turn.
    const highUsageEnd: FakeChunk = {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { total_tokens: 850_000 },
    };
    const client = fakeClient([
      [
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "noop", arguments: "{}" } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
        highUsageEnd,
      ],
      textResponse("done"),
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      client,
      model: "test-model",
      systemPrompt: "sys",
      history: longHistory,
      registry: new ToolRegistry([noop]),
      summarize: async () => "digest", // keep the default summariser off the fake client (rung 1 wins here anyway)
      onEvent: (e) => events.push(e),
    });
    const compactions = events.filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThan(0);
    expect((compactions[0] as { mode?: string }).mode).toBe("microcompact");
    expect(result.stopReason).toBe("end_turn");
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
