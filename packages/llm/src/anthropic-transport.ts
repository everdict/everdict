import { UpstreamError } from "@everdict/contracts";
import type {
  LlmMessage,
  LlmTool,
  LlmToolCall,
  LlmTransport,
  LlmUsage,
  StreamRequest,
  StreamResult,
} from "./transport.js";

export interface AnthropicTransportConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
}

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const EPHEMERAL = { type: "ephemeral" } as const;

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
type OutBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;
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
function foldMessages(system: string, messages: LlmMessage[]): { system: string; out: OutMessage[] } {
  const systemParts: string[] = system.length > 0 ? [system] : [];
  const out: OutMessage[] = [];
  const push = (role: "user" | "assistant", blocks: OutBlock[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content.length > 0) systemParts.push(m.content);
    } else if (m.role === "user") {
      push("user", contentToBlocks(m.content));
    } else if (m.role === "assistant") {
      const blocks: OutBlock[] = [];
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
      push("user", [{ type: "tool_result", tool_use_id: id, content: contentToString(m.content) }]);
    }
  }
  return { system: systemParts.join("\n\n"), out };
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

  async stream(req: StreamRequest): Promise<StreamResult> {
    const cacheSystem = req.cache?.system === true;
    const cacheTools = req.cache?.tools === true;
    const { system, out } = foldMessages(req.system, req.messages);
    // Rolling history breakpoint: cache_control on the last block of the last turn caches the conversation prefix up to
    // this turn — next turn's identical prefix is a cache hit.
    if ((cacheSystem || cacheTools) && out.length > 0) {
      const lastMsg = out[out.length - 1];
      const lastBlock = lastMsg?.content[lastMsg.content.length - 1];
      if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "tool_result")) {
        lastBlock.cache_control = EPHEMERAL;
      }
    }
    const systemField =
      cacheSystem && system.length > 0 ? [{ type: "text", text: system, cache_control: EPHEMERAL }] : system;

    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: systemField,
      messages: out,
      ...(req.tools.length > 0 ? { tools: toAnthropicTools(req.tools, cacheTools) } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      stream: true,
    };

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
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        {},
        `model call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok || res.body === null) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError("UPSTREAM_ERROR", { status: res.status }, `model ${res.status}: ${text.slice(0, 200)}`);
    }

    return this.consume(res.body, req.onContentDelta);
  }

  // Parse the Anthropic SSE event stream into a canonical StreamResult.
  private async consume(
    stream: ReadableStream<Uint8Array>,
    onDelta: StreamRequest["onContentDelta"],
  ): Promise<StreamResult> {
    let content = "";
    const toolBlocks = new Map<number, { id: string; name: string; args: string }>();
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
        const block = evt.content_block as { type?: string; id?: string; name?: string } | undefined;
        if (block?.type === "tool_use" && typeof idx === "number")
          toolBlocks.set(idx, { id: block.id ?? "", name: block.name ?? "", args: "" });
      } else if (evt.type === "content_block_delta") {
        const idx = evt.index as number;
        const delta = evt.delta as { type?: string; text?: string; partial_json?: string } | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          content += delta.text;
          onDelta?.(delta.text);
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const b = toolBlocks.get(idx);
          if (b) b.args += delta.partial_json;
        }
      } else if (evt.type === "message_delta") {
        const delta = evt.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        const usage = evt.usage as { output_tokens?: number } | undefined;
        if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
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

    // inputTokens = the full prompt footprint (non-cached + cache read + cache creation); cacheRead/Write are the
    // subsets, surfaced for observability of the caching win.
    const usage: LlmUsage = {
      inputTokens: inputTokens + cacheRead + cacheWrite,
      outputTokens,
      totalTokens: inputTokens + cacheRead + cacheWrite + outputTokens,
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    };

    return { content: content.length > 0 ? content : null, toolCalls, finishReason: stopReason, usage };
  }
}
