import { UpstreamError } from "@everdict/contracts";
import type {
  LlmMessage,
  LlmTool,
  LlmToolCall,
  LlmTransport,
  LlmUsage,
  ReasoningCarrier,
  StreamRequest,
  StreamResult,
  TransientCarrier,
} from "./transport.js";

export interface AnthropicTransportConfig {
  apiKey: string;
  baseUrl?: string;
  // Deadline for the request to RESPOND (time-to-headers). The streaming body is covered separately by
  // streamIdleTimeoutMs. <= 0 disables. Default 10 minutes (the API's own non-streaming boundary).
  timeoutMs?: number;
  // Watchdog on the SSE body: if no chunk arrives for this long the stream is considered dead and the call fails
  // with a retryable UpstreamError — a silently dropped connection must not pin the agent loop forever. <= 0
  // disables (tests). Default 90s (Claude Code's stream-idle watchdog parity).
  streamIdleTimeoutMs?: number;
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
}

const ANTHROPIC_VERSION = "2023-06-01";
// Output cap when the caller doesn't set one. 4096 silently truncated long tool arguments (a cut-off input_json
// surfaces only as a JSON parse failure downstream); 8192 is supported across current Claude models.
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;
const EPHEMERAL = { type: "ephemeral" } as const;

// Parse the server's retry hints into a delay: `retry-after` (seconds or an HTTP date) wins, else the unified
// rate-limit reset timestamp. Undefined when the response carries neither. Surfaced on the UpstreamError so the
// agent loop can honor the server's own pacing instead of guessing with backoff.
export function retryAfterMsOf(headers: Headers, nowMs = Date.now()): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs) && dateMs > nowMs) return dateMs - nowMs;
  }
  const reset = headers.get("anthropic-ratelimit-unified-reset");
  if (reset !== null) {
    const resetSec = Number(reset);
    if (Number.isFinite(resetSec)) {
      const delta = resetSec * 1000 - nowMs;
      if (delta > 0) return delta;
    }
  }
  return undefined;
}

// --- Anthropic wire shapes (only the fields we send/read) ---
interface TextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}
interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  cache_control?: { type: "ephemeral" };
}
// Extended-thinking blocks. On the way IN they replay a prior assistant turn's reasoning (Anthropic requires the
// thinking block, with its signature, be preserved when tool_use follows thinking); on the way OUT they're what the
// stream produced. `redacted_thinking` carries encrypted reasoning the model chose not to surface — still replayed.
interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}
interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}
type ThinkingOutBlock = ThinkingBlock | RedactedThinkingBlock;
type OutBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingOutBlock;

// Read the reasoning blocks the kernel attached to an assistant message (side-channel) for same-turn thinking replay.
function reasoningBlocksOf(m: LlmMessage): ThinkingOutBlock[] {
  const blocks = (m as ReasoningCarrier).reasoning?.blocks;
  if (!Array.isArray(blocks)) return [];
  const out: ThinkingOutBlock[] = [];
  for (const b of blocks) {
    if (b === null || typeof b !== "object") continue;
    const t = (b as { type?: unknown }).type;
    if (t === "thinking" || t === "redacted_thinking") out.push(b as ThinkingOutBlock);
  }
  return out;
}
interface OutMessage {
  role: "user" | "assistant";
  content: OutBlock[];
}
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
}

function contentToString(content: LlmMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p) => (typeof p === "object" && p !== null && "text" in p && typeof p.text === "string" ? p.text : ""))
      .join("");
  return "";
}

// Translate an OpenAI-shaped content value (string or content parts) into Anthropic content blocks. image_url parts
// (the multimodal tool-result channel) become native base64 image blocks; a bare data URL is split into mime + data.
function contentToBlocks(content: LlmMessage["content"]): OutBlock[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: OutBlock[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    if ("text" in part && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if ("image_url" in part) {
      const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
      if (typeof url !== "string") continue;
      const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (match?.[1] && match[2] !== undefined) {
        blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
      }
    }
  }
  return blocks;
}

function parseInput(raw: string): unknown {
  const text = raw.trim();
  if (text.length === 0) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Fold the canonical (OpenAI-shaped) message list into Anthropic's system param + messages. Anthropic differs from
// OpenAI in three ways this handles: (1) system is a top-level param, not a message; (2) tool results live in a USER
// turn as tool_result blocks (not a "tool" role); (3) consecutive same-role turns must be merged into one message.
// `lastStable` is the last cacheable block that came from a NON-transient message — the rolling prompt-cache
// breakpoint must land there, never on a per-request reminder that won't recur in the next request's history.
function foldMessages(
  system: string,
  messages: LlmMessage[],
): { system: string; out: OutMessage[]; lastStable?: TextBlock | ToolResultBlock } {
  const systemParts: string[] = system.length > 0 ? [system] : [];
  const out: OutMessage[] = [];
  let lastStable: TextBlock | ToolResultBlock | undefined;
  const push = (role: "user" | "assistant", blocks: OutBlock[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    let blocks: OutBlock[] = [];
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content.length > 0) systemParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      blocks = contentToBlocks(m.content);
      push("user", blocks);
    } else if (m.role === "assistant") {
      // Thinking blocks must LEAD the assistant turn (Anthropic rejects a tool_use turn whose thinking isn't first).
      blocks = [...reasoningBlocksOf(m)];
      const text = contentToString(m.content);
      if (text.length > 0) blocks.push({ type: "text", text });
      const toolCalls = m.tool_calls ?? [];
      for (const tc of toolCalls) {
        if (tc.type !== "function") continue;
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseInput(tc.function.arguments) });
      }
      push("assistant", blocks);
    } else if (m.role === "tool") {
      const id = "tool_call_id" in m && typeof m.tool_call_id === "string" ? m.tool_call_id : "";
      blocks = [{ type: "tool_result", tool_use_id: id, content: contentToString(m.content) }];
      push("user", blocks);
    }
    if ((m as TransientCarrier).transient === true) continue;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b && (b.type === "text" || b.type === "tool_result")) {
        lastStable = b;
        break;
      }
    }
  }
  return { system: systemParts.join("\n\n"), out, ...(lastStable ? { lastStable } : {}) };
}

function toAnthropicTools(tools: LlmTool[], cache: boolean): AnthropicTool[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parametersJsonSchema,
    // One breakpoint at the END of the tools array caches the whole (static) tool prefix.
    ...(cache && i === tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }));
}

// Native Anthropic Messages API transport (fetch + streaming SSE). Applies cache_control breakpoints on the stable
// prefix (tools + system) and a rolling one on the last turn, so a long multi-turn agent run re-reads a cached prefix
// each turn (the KV-cache win) instead of re-billing the whole context every time.
export class AnthropicTransport implements LlmTransport {
  readonly provider = "anthropic";
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly config: AnthropicTransportConfig) {
    this.base = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.f = config.fetchImpl ?? fetch;
  }

  // Build the request body (minus `stream`): message/tool translation + cache_control breakpoints on the stable prefix
  // (tools + system) and a rolling one on the last turn.
  private buildBody(req: StreamRequest): Record<string, unknown> {
    const cacheSystem = req.cache?.system === true;
    const cacheTools = req.cache?.tools === true;
    const { system, out, lastStable } = foldMessages(req.system, req.messages);
    // Rolling breakpoint on the last STABLE block (never a transient per-request reminder — a breakpoint there keys
    // the cache entry to a prefix that never recurs, so every turn would pay a cache write that is never read).
    if ((cacheSystem || cacheTools) && lastStable) lastStable.cache_control = EPHEMERAL;
    const systemField =
      cacheSystem && system.length > 0 ? [{ type: "text", text: system, cache_control: EPHEMERAL }] : system;
    // Extended thinking: max_tokens must exceed the thinking budget (it caps thinking + visible output), and temperature
    // must be left at its default (Anthropic rejects a non-default temperature alongside thinking) — so we drop it.
    const thinking = req.thinking;
    const baseMaxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    const maxTokens = thinking ? Math.max(baseMaxTokens, thinking.budgetTokens + DEFAULT_MAX_TOKENS) : baseMaxTokens;
    return {
      model: req.model,
      max_tokens: maxTokens,
      system: systemField,
      messages: out,
      ...(req.tools.length > 0 ? { tools: toAnthropicTools(req.tools, cacheTools) } : {}),
      ...(thinking
        ? { thinking: { type: "enabled", budget_tokens: thinking.budgetTokens } }
        : req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
    };
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    // The request deadline covers time-to-headers only: the timer is cleared once the response arrives, so a long
    // SSE body is never killed by it (the idle watchdog in consume() owns the body). The caller's signal is
    // forwarded through the same controller, so a run abort still cancels the in-flight body.
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : undefined;
    let res: Response;
    try {
      res = await this.f(`${this.base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) {
        throw new UpstreamError("UPSTREAM_ERROR", {}, `model call timed out after ${timeoutMs}ms with no response`);
      }
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        {},
        `model call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Surface the server's own retry pacing (Retry-After / rate-limit reset) so the caller's retry policy can
      // honor it instead of guessing.
      const retryAfterMs = retryAfterMsOf(res.headers);
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
        `model ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    return res;
  }

  async stream(req: StreamRequest): Promise<StreamResult> {
    const res = await this.post({ ...this.buildBody(req), stream: true }, req.signal);
    if (res.body === null) throw new UpstreamError("UPSTREAM_ERROR", {}, "The model stream response has no body.");
    const result = await this.consume(res.body, req.onContentDelta, req.onReasoningDelta, req.signal);
    // Completeness check (Claude Code parity): a proxy can return 200 and end the body early — no events at all,
    // or a message_start with no completed content and no stop_reason. Treating that as a finished turn corrupts
    // the run (an empty/truncated "answer"); failing makes it a retryable upstream error instead.
    if (result.content === null && result.toolCalls.length === 0 && result.finishReason === null) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        {},
        "model stream ended prematurely: no content and no stop_reason received",
      );
    }
    return result;
  }

  // One-shot, non-streaming completion (judges / probes) — the final Messages response instead of an SSE stream.
  async complete(req: StreamRequest): Promise<StreamResult> {
    const res = await this.post(this.buildBody(req), req.signal);
    const json = (await res.json()) as {
      content?: Array<{
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
        thinking?: string;
        signature?: string;
        data?: string;
      }>;
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    let content = "";
    let reasoning = "";
    const reasoningBlocks: ThinkingOutBlock[] = [];
    const toolCalls: LlmToolCall[] = [];
    for (const block of json.content ?? []) {
      // thinking/redacted_thinking blocks are the model's reasoning (preserved verbatim for same-turn tool-use replay);
      // tool_use blocks become tool calls; any block carrying `text` is the visible answer.
      if (block.type === "tool_use") {
        toolCalls.push({ id: block.id ?? "", name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        reasoning += block.thinking;
        reasoningBlocks.push({ type: "thinking", thinking: block.thinking, signature: block.signature ?? "" });
      } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
        reasoningBlocks.push({ type: "redacted_thinking", data: block.data });
      } else if (typeof block.text === "string") {
        content += block.text;
      }
    }
    const u = json.usage;
    const cacheRead = u?.cache_read_input_tokens ?? 0;
    const cacheWrite = u?.cache_creation_input_tokens ?? 0;
    const inputTokens = (u?.input_tokens ?? 0) + cacheRead + cacheWrite;
    const outputTokens = u?.output_tokens ?? 0;
    return {
      content: content.length > 0 ? content : null,
      toolCalls: toolCalls.filter((c) => c.id.length > 0 && c.name.length > 0),
      finishReason: json.stop_reason ?? null,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
      },
      ...(reasoning.length > 0 ? { reasoning } : {}),
      ...(reasoningBlocks.length > 0 ? { reasoningBlocks } : {}),
    };
  }

  // Parse the Anthropic SSE event stream into a canonical StreamResult.
  private async consume(
    stream: ReadableStream<Uint8Array>,
    onDelta: StreamRequest["onContentDelta"],
    onReasoning: StreamRequest["onReasoningDelta"],
    signal?: AbortSignal,
  ): Promise<StreamResult> {
    let content = "";
    const toolBlocks = new Map<number, { id: string; name: string; args: string }>();
    // Reasoning blocks accumulate by stream index (they precede text/tool_use), so an index sort restores their order.
    const thinkingBlocks = new Map<number, ThinkingBlock | RedactedThinkingBlock>();
    let reasoning = "";
    let stopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (data: string): void => {
      let evt: { type?: string } & Record<string, unknown>;
      try {
        evt = JSON.parse(data);
      } catch {
        return;
      }
      if (evt.type === "message_start") {
        const usage = (evt.message as { usage?: Record<string, number> } | undefined)?.usage;
        if (usage) {
          inputTokens = usage.input_tokens ?? 0;
          cacheRead = usage.cache_read_input_tokens ?? 0;
          cacheWrite = usage.cache_creation_input_tokens ?? 0;
        }
      } else if (evt.type === "content_block_start") {
        const idx = evt.index as number;
        const block = evt.content_block as { type?: string; id?: string; name?: string; data?: string } | undefined;
        if (block?.type === "tool_use" && typeof idx === "number")
          toolBlocks.set(idx, { id: block.id ?? "", name: block.name ?? "", args: "" });
        else if (block?.type === "thinking" && typeof idx === "number")
          thinkingBlocks.set(idx, { type: "thinking", thinking: "", signature: "" });
        else if (block?.type === "redacted_thinking" && typeof idx === "number")
          thinkingBlocks.set(idx, { type: "redacted_thinking", data: block.data ?? "" });
      } else if (evt.type === "content_block_delta") {
        const idx = evt.index as number;
        const delta = evt.delta as
          | { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string }
          | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          content += delta.text;
          onDelta?.(delta.text);
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const b = toolBlocks.get(idx);
          if (b) b.args += delta.partial_json;
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          const b = thinkingBlocks.get(idx);
          if (b?.type === "thinking") b.thinking += delta.thinking;
          reasoning += delta.thinking;
          onReasoning?.(delta.thinking);
        } else if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
          const b = thinkingBlocks.get(idx);
          if (b?.type === "thinking") b.signature += delta.signature;
        }
      } else if (evt.type === "message_delta") {
        const delta = evt.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        const usage = evt.usage as { output_tokens?: number } | undefined;
        if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
      }
    };

    // Idle watchdog: each read races a fresh idle timer. A silently dropped connection makes reader.read() pend
    // forever — without this the whole agent turn hangs until someone kills it from outside. On fire the reader is
    // cancelled and the call fails as a retryable timeout. A caller abort surfaces as reader.read() rejecting.
    const idleMs = this.config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    const IDLE = Symbol("stream-idle");
    const readWithIdleWatchdog = async (): Promise<Awaited<ReturnType<typeof reader.read>>> => {
      if (idleMs <= 0) return reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<typeof IDLE>((resolve) => {
        timer = setTimeout(() => resolve(IDLE), idleMs);
      });
      try {
        const r = await Promise.race([reader.read(), idle]);
        if (r === IDLE) {
          await reader.cancel().catch(() => {});
          throw new UpstreamError("UPSTREAM_ERROR", {}, `model stream idle timeout: no data received for ${idleMs}ms`);
        }
        return r;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new UpstreamError("UPSTREAM_ERROR", {}, "model stream aborted by the caller");
      }
      const { done, value } = await readWithIdleWatchdog();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) if (line.startsWith("data:")) handle(line.slice(5).trim());
        boundary = buffer.indexOf("\n\n");
      }
    }

    const toolCalls: LlmToolCall[] = Array.from(toolBlocks.entries())
      .sort(([a], [b]) => a - b)
      .map(([, b]) => ({ id: b.id, name: b.name, arguments: b.args.length > 0 ? b.args : "{}" }))
      .filter((c) => c.id.length > 0 && c.name.length > 0);

    const reasoningBlocks: ThinkingOutBlock[] = Array.from(thinkingBlocks.entries())
      .sort(([a], [b]) => a - b)
      .map(([, b]) => b);

    // inputTokens = the full prompt footprint (non-cached + cache read + cache creation); cacheRead/Write are the
    // subsets, surfaced for observability of the caching win.
    const usage: LlmUsage = {
      inputTokens: inputTokens + cacheRead + cacheWrite,
      outputTokens,
      totalTokens: inputTokens + cacheRead + cacheWrite + outputTokens,
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    };

    return {
      content: content.length > 0 ? content : null,
      toolCalls,
      finishReason: stopReason,
      usage,
      ...(reasoning.length > 0 ? { reasoning } : {}),
      ...(reasoningBlocks.length > 0 ? { reasoningBlocks } : {}),
    };
  }
}
