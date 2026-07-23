import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { OpenAiTransport } from "./openai-transport.js";
import type { StreamRequest } from "./transport.js";

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;

// A fake OpenAI client that streams a fixed sequence of chunks and records the create() args for assertions.
function fakeClient(chunks: Partial<Chunk>[]): { client: OpenAI; lastArgs: () => unknown } {
  let args: unknown;
  const create = (a: unknown) => {
    args = a;
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  };
  return {
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    lastArgs: () => args,
  };
}

const baseReq: StreamRequest = { model: "gpt-x", system: "You are helpful.", messages: [], tools: [] };

describe("OpenAiTransport", () => {
  it("accumulates streamed text and reports normalized usage", async () => {
    const deltas: string[] = [];
    const { client } = fakeClient([
      { choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      } as Partial<Chunk>,
    ]);
    const result = await new OpenAiTransport(client).stream({
      ...baseReq,
      onContentDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result.content).toBe("Hello");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 5, totalTokens: 105, cacheReadTokens: 80 });
  });

  it("assembles tool-call fragments into ordered, complete tool calls", async () => {
    const frag1 = { index: 0, id: "call_1", function: { name: "get_run", arguments: '{"id":' } };
    const frag2 = { index: 0, function: { arguments: '"r1"}' } };
    const { client } = fakeClient([
      { choices: [{ index: 0, delta: { tool_calls: [frag1] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [frag2] }, finish_reason: "tool_calls" }] },
    ] as Partial<Chunk>[]);
    const result = await new OpenAiTransport(client).stream(baseReq);
    expect(result.content).toBeNull();
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "get_run", arguments: '{"id":"r1"}' }]);
  });

  it("prepends the system message and renders tools into the OpenAI function shape", async () => {
    const { client, lastArgs } = fakeClient([
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
    ]);
    await new OpenAiTransport(client).stream({
      ...baseReq,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get_run", description: "Fetch a run", parametersJsonSchema: { type: "object" } }],
    });
    const args = lastArgs() as {
      messages: { role: string; content: string }[];
      tools: { type: string; function: { name: string; parameters: unknown } }[];
    };
    expect(args.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(args.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(args.tools[0]).toEqual({
      type: "function",
      function: { name: "get_run", description: "Fetch a run", parameters: { type: "object" } },
    });
  });
});
