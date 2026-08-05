import { describe, expect, it } from "vitest";
import { AnthropicTransport, retryAfterMsOf } from "./anthropic-transport.js";
import type { LlmMessage, StreamRequest, TransientCarrier } from "./transport.js";

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
    const { fetchImpl, body } = fakeFetch([
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      frame({ type: "message_stop" }),
    ]);
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
    const { fetchImpl, body } = fakeFetch([
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      frame({ type: "message_stop" }),
    ]);
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

  it("keeps the rolling cache breakpoint off a transient per-request reminder", async () => {
    // Given a history whose LAST message is a transient reminder (re-rendered each call, absent next request)
    const { fetchImpl, body } = fakeFetch([
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      frame({ type: "message_stop" }),
    ]);
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl });
    const reminder: LlmMessage = { role: "user", content: "<system-reminder>todo list</system-reminder>" };
    (reminder as TransientCarrier).transient = true;
    // When the request is built with caching on
    await transport.stream({
      ...base,
      messages: [{ role: "user", content: "question" }, { role: "assistant", content: "answer" }, reminder],
      cache: { system: true, tools: true },
    });
    // Then the breakpoint lands on the last STABLE block (the assistant answer) — a breakpoint on the reminder
    // would key the cache entry to a prefix that never recurs, so it would be written every turn and never read.
    const msgs = body().messages as { role: string; content: { text?: string; cache_control?: unknown }[] }[];
    expect(msgs[1]?.content[0]?.cache_control).toEqual({ type: "ephemeral" });
    const lastContent = msgs[2]?.content ?? [];
    expect(lastContent[lastContent.length - 1]?.cache_control).toBeUndefined();
  });

  it("captures streamed thinking as reasoning text + replayable blocks (with signature)", async () => {
    const reasoning: string[] = [];
    const { fetchImpl } = fakeFetch([
      frame({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Weigh " } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "options." } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } }),
      frame({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } }),
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
      frame({ type: "message_stop" }),
    ]);
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl });
    const result = await transport.stream({ ...base, onReasoningDelta: (d) => reasoning.push(d) });
    expect(reasoning).toEqual(["Weigh ", "options."]);
    expect(result.reasoning).toBe("Weigh options.");
    expect(result.content).toBe("Answer");
    expect(result.reasoningBlocks).toEqual([{ type: "thinking", thinking: "Weigh options.", signature: "sig123" }]);
  });

  it("enables extended thinking: sends a thinking budget, bumps max_tokens, and drops temperature", async () => {
    const { fetchImpl, body } = fakeFetch([
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      frame({ type: "message_stop" }),
    ]);
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl });
    await transport.stream({ ...base, temperature: 0.7, maxTokens: 1000, thinking: { budgetTokens: 2048 } });
    const b = body();
    expect(b.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(b.temperature).toBeUndefined(); // Anthropic rejects a non-default temperature with thinking
    expect(b.max_tokens).toBe(2048 + 8192); // bumped above the budget to leave room for output
  });

  it("replays a prior assistant turn's thinking blocks as the leading content block", async () => {
    const { fetchImpl, body } = fakeFetch([
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      frame({ type: "message_stop" }),
    ]);
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl });
    await transport.stream({
      ...base,
      messages: [
        { role: "user", content: "go" },
        // The kernel attaches captured thinking blocks via the reasoning side-channel for same-turn replay.
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "tu_1", type: "function", function: { name: "get_run", arguments: "{}" } }],
          reasoning: { text: "…", blocks: [{ type: "thinking", thinking: "…", signature: "sig" }] },
        } as never,
        { role: "tool", tool_call_id: "tu_1", content: "ok" },
      ],
    });
    const msgs = body().messages as { role: string; content: { type: string; [k: string]: unknown }[] }[];
    // The assistant turn leads with the thinking block, then the tool_use — Anthropic's replay ordering.
    expect(msgs[1]?.content[0]).toEqual({ type: "thinking", thinking: "…", signature: "sig" });
    expect(msgs[1]?.content[1]).toMatchObject({ type: "tool_use", id: "tu_1", name: "get_run" });
  });

  it("maps a non-2xx response to an UpstreamError", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl });
    await expect(transport.stream(base)).rejects.toThrow(/model 401/);
  });

  it("surfaces the server's Retry-After (and rate-limit reset) as retryAfterMs on the UpstreamError", async () => {
    // Given a 429 whose Retry-After says 7 seconds
    const fetchImpl = (async () =>
      new Response("rate limited", { status: 429, headers: { "retry-after": "7" } })) as unknown as typeof fetch;
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl });
    // When the call fails, Then the error carries the server's own pacing for the caller's retry policy
    const err = await transport.stream(base).catch((e: unknown) => e);
    expect(err).toMatchObject({ extra: { status: 429, retryAfterMs: 7000 } });
  });

  it("retryAfterMsOf falls back to the unified rate-limit reset timestamp", () => {
    const now = 1_700_000_000_000;
    const headers = new Headers({ "anthropic-ratelimit-unified-reset": String((now + 90_000) / 1000) });
    expect(retryAfterMsOf(headers, now)).toBe(90_000);
    expect(retryAfterMsOf(new Headers(), now)).toBeUndefined();
  });

  it("fails a stream that ends prematurely (no events, no stop_reason) instead of returning an empty turn", async () => {
    // Given a proxy-style 200 whose body ends without a single meaningful event
    const { fetchImpl } = fakeFetch([]);
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl });
    // Then the call fails as a retryable upstream error rather than a silent empty "answer"
    await expect(transport.stream(base)).rejects.toThrow(/stream ended prematurely/);
  });

  it("aborts a silently hung stream via the idle watchdog and fails as a retryable timeout", async () => {
    // Given a stream that sends message_start and then goes silent forever
    const enc = new TextEncoder();
    const hung = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(frame({ type: "message_start", message: { usage: { input_tokens: 1 } } })));
        // …and never closes or enqueues again (a dropped connection the network never reports)
      },
    });
    const fetchImpl = (async () => new Response(hung, { status: 200 })) as unknown as typeof fetch;
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl, streamIdleTimeoutMs: 30 });
    // Then the watchdog frees the caller instead of pinning the agent turn forever
    await expect(transport.stream(base)).rejects.toThrow(/stream idle timeout/);
  });

  it("times out a request that never responds (timeoutMs is enforced, not just declared)", async () => {
    // Given a fetch that hangs forever before returning headers, but honors its abort signal
    const fetchImpl = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as unknown as typeof fetch;
    const transport = new AnthropicTransport({ apiKey: "k", fetchImpl, timeoutMs: 30 });
    await expect(transport.stream(base)).rejects.toThrow(/timed out after 30ms/);
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
