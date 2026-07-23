import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../messages.js";
import type { PermissionDecision, PermissionRequest, ToolDefinition } from "../tools/definition.js";
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

  it("surfaces tool-returned images as a follow-up multimodal user turn (in-run, not persisted)", async () => {
    const shot: ToolDefinition = {
      name: "shot",
      description: "screenshot",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: async () => ({ content: "captured", isError: false, images: [{ data: "AAAA", mediaType: "image/png" }] }),
    };
    const seenRequests: ChatMessage[][] = [];
    let call = 0;
    const responses: FakeChunk[][] = [
      [
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "shot", arguments: "{}" } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
        usageEnd,
      ],
      textResponse("I see a red button"),
    ];
    const create = (body: { messages: ChatMessage[] }): AsyncGenerator<FakeChunk> => {
      seenRequests.push(body.messages);
      const chunks = responses[call] ?? [];
      call += 1;
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    };
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const result = await runAgentLoop({
      client,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([shot]),
    });
    // Turn 2's request carries the image as an image_url content part.
    const turn2 = seenRequests[1] ?? [];
    const imgMsg = turn2.find((m) => m.role === "user" && Array.isArray(m.content));
    const parts = (imgMsg as { content: Array<{ type: string; image_url?: { url: string } }> } | undefined)?.content;
    expect(parts?.find((p) => p.type === "image_url")?.image_url?.url).toContain("data:image/png;base64,AAAA");
    // The multimodal message is in-run only — the persisted transcript stays assistant/tool/assistant (no base64 bloat).
    expect(result.produced.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result.content).toBe("I see a red button");
  });

  it("gates write tools through the permit hook and auto-allows read-only tools", async () => {
    const writeCall = vi.fn(async () => ({ content: "wrote", isError: false }));
    const readCall = vi.fn(async () => ({ content: "read", isError: false }));
    const writeTool: ToolDefinition = {
      name: "do_write",
      description: "write",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: false,
      call: writeCall,
    };
    const readTool: ToolDefinition = {
      name: "do_read",
      description: "read",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: readCall,
    };
    const permit = vi.fn(
      async (req: PermissionRequest): Promise<PermissionDecision> => (req.name === "do_write" ? "deny" : "allow"),
    );
    // One turn, two tool calls (a write + a read); permit denies the write.
    const client = fakeClient([
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "w", function: { name: "do_write", arguments: "{}" } },
                  { index: 1, id: "r", function: { name: "do_read", arguments: "{}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        usageEnd,
      ],
      textResponse("done"),
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      client,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([writeTool, readTool]),
      permit,
      onEvent: (e) => events.push(e),
    });
    expect(writeCall).not.toHaveBeenCalled(); // denied
    expect(readCall).toHaveBeenCalledOnce(); // read-only → auto-allowed
    expect(permit).toHaveBeenCalledOnce(); // consulted only for the write tool
    expect(events.filter((e) => e.type === "permission")).toEqual([
      { type: "permission", name: "do_write", decision: "deny" },
    ]);
    expect(result.toolCalls.find((t) => t.name === "do_write")?.ok).toBe(false);
  });

  it("dispatches multiple tool calls concurrently but appends results in call order", async () => {
    const finished: string[] = [];
    const slow: ToolDefinition = {
      name: "slow",
      description: "slow",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: async () => {
        await new Promise((r) => setTimeout(r, 10));
        finished.push("slow");
        return { content: "slow-done", isError: false };
      },
    };
    const fast: ToolDefinition = {
      name: "fast",
      description: "fast",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: async () => {
        finished.push("fast");
        return { content: "fast-done", isError: false };
      },
    };
    const client = fakeClient([
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "s", function: { name: "slow", arguments: "{}" } },
                  { index: 1, id: "f", function: { name: "fast", arguments: "{}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        usageEnd,
      ],
      textResponse("done"),
    ]);
    const result = await runAgentLoop({
      client,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([slow, fast]),
    });
    // Concurrency: the fast tool completed before the slow one (sequential would be ["slow","fast"]).
    expect(finished).toEqual(["fast", "slow"]);
    // But the transcript preserves CALL order — slow's result precedes fast's (pairing must stay ordered).
    const toolContents = result.produced
      .filter((m) => m.role === "tool")
      .map((m) => (m as { content: string }).content);
    expect(toolContents).toEqual(["slow-done", "fast-done"]);
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
