import { describe, expect, it } from "vitest";
import { AnthropicTransport } from "./anthropic-transport.js";
import type { StreamRequest } from "./transport.js";

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}
const frame = (obj: unknown): string => `event: x\ndata: ${JSON.stringify(obj)}\n\n`;

// A fake fetch that captures the request body and streams back the given SSE frames.
function fakeFetch(frames: string[]): { fetchImpl: typeof fetch; body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(sseStream(frames), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, body: () => captured };
}

const base: StreamRequest = { model: "claude-x", system: "SYS", messages: [], tools: [] };

describe("AnthropicTransport", () => {
  it("streams text + tool_use and normalizes usage incl. cache tokens", async () => {
    const deltas: string[] = [];
    const { fetchImpl } = fakeFetch([
      frame({
        type: "message_start",
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } },
      }),
      frame({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
      frame({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_1", name: "get_run" },
      }),
      frame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"id":' } }),
      frame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"r1"}' } }),
      frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
      frame({ type: "message_stop" }),
    ]);
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl });
    const result = await transport.stream({ ...base, onContentDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result.content).toBe("Hello");
    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{ id: "tu_1", name: "get_run", arguments: '{"id":"r1"}' }]);
    expect(result.usage).toEqual({
      inputTokens: 190,
      outputTokens: 5,
      totalTokens: 195,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
    });
  });

  it("folds a tool result into a user turn and renders an image_url as a native image block", async () => {
    const { fetchImpl, body } = fakeFetch([frame({ type: "message_stop" })]);
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl });
    await transport.stream({
      ...base,
      messages: [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "tu_1", type: "function", function: { name: "get_run", arguments: '{"id":"r1"}' } }],
        },
        { role: "tool", tool_call_id: "tu_1", content: "ok" },
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      ],
    });
    const msgs = body().messages as { role: string; content: { type: string; [k: string]: unknown }[] }[];
    // user("run it") · assistant(tool_use) · user(tool_result + image, merged)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1]?.content[0]).toMatchObject({ type: "tool_use", id: "tu_1", name: "get_run", input: { id: "r1" } });
    const merged = msgs[2]?.content ?? [];
    expect(merged[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1", content: "ok" });
    expect(merged[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  });

  it("places cache_control breakpoints on system, the last tool, and the last turn", async () => {
    const { fetchImpl, body } = fakeFetch([frame({ type: "message_stop" })]);
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl });
    await transport.stream({
      ...base,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "a", description: "A", parametersJsonSchema: { type: "object" } },
        { name: "b", description: "B", parametersJsonSchema: { type: "object" } },
      ],
      cache: { system: true, tools: true },
    });
    const b = body();
    expect(b.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
    const tools = b.tools as { name: string; cache_control?: unknown }[];
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral" });
    const msgs = b.messages as { content: { cache_control?: unknown }[] }[];
    expect(msgs[0]?.content[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("maps a non-2xx response to an UpstreamError", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl });
    await expect(transport.stream(base)).rejects.toThrow(/model 401/);
  });

  it("complete() reads a non-streaming Messages response (first text block + tool_use)", async () => {
    let body = "";
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      body = init.body;
      return new Response(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "…" },
            { type: "text", text: "verdict" },
            { type: "tool_use", id: "tu_1", name: "get_run", input: { id: "r1" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 4 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await new AnthropicTransport({ apiKey: "k", fetchImpl }).complete(base);
    expect(JSON.parse(body).stream).toBeUndefined(); // non-streaming request
    expect(result.content).toBe("verdict"); // skips the thinking block
    expect(result.toolCalls).toEqual([{ id: "tu_1", name: "get_run", arguments: '{"id":"r1"}' }]);
    expect(result.usage).toEqual({ inputTokens: 14, outputTokens: 2, totalTokens: 16, cacheReadTokens: 4 });
  });
});
