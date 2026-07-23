import type OpenAI from "openai";

// @everdict/llm — provider-NATIVE LLM transports. everdict deliberately does NOT go provider-agnostic-over-LiteLLM:
// each provider gets a native transport so we can speak its own message protocol and use its own prompt/KV caching.
// The kernel (and the judges) manipulate one canonical message shape; a transport translates it to the provider's wire
// format on the way out and normalizes the reply on the way back.

// The canonical internal message shape callers manipulate (tool pairing, compaction). It mirrors OpenAI's chat shape —
// a well-understood lingua franca — but that is an internal detail behind this alias, not a commitment to OpenAI's wire
// protocol: the Anthropic transport translates it to system-param + content-block form.
export type LlmMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// A tool the model may call. Parameters are neutral JSON Schema; each transport renders them into its provider's tool
// format (OpenAI `function.parameters`, Anthropic `input_schema`).
export interface LlmTool {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string, as the provider emitted it
}

// Token accounting normalized across providers. cacheRead/cacheWrite are populated when the provider reports prompt-
// cache activity (Anthropic cache_read/creation input tokens; OpenAI cached prompt tokens) so callers can see the win.
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// Where to place prompt-cache breakpoints on the stable prefix. Providers that cache automatically (OpenAI) ignore it;
// Anthropic uses it to emit cache_control markers on the tools + system prefix so a long multi-turn run re-reads a
// cached prefix instead of re-billing it every turn.
export interface CacheHints {
  system?: boolean;
  tools?: boolean;
}

export interface StreamRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onContentDelta?: (delta: string) => void;
  cache?: CacheHints;
}

export interface StreamResult {
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason: string | null;
  usage?: LlmUsage;
}

// A provider-native transport: translate the canonical request to the provider's API (message protocol, tool format,
// prompt caching), stream it, and normalize the reply. One method serves both agentic turns (with tools) and one-shot
// completions (empty tools) — e.g. the compaction summariser and model judges.
export interface LlmTransport {
  readonly provider: string;
  stream(req: StreamRequest): Promise<StreamResult>;
}
