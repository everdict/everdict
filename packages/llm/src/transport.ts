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

// Extended-thinking / reasoning request. Enables the provider's native reasoning (Anthropic `thinking`; OpenAI-side
// reasoning models emit reasoning regardless, so this is a no-op there and capture is always on). budgetTokens caps
// the thinking budget (Anthropic). Absent → thinking off (the historical behaviour); reasoning is still CAPTURED if
// the model emits it unprompted.
export interface ReasoningRequest {
  budgetTokens: number;
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
  // Live reasoning/thinking token deltas (extended thinking). Fires only when the model emits reasoning; a normal
  // (non-reasoning) turn never calls it, so callers can wire it unconditionally.
  onReasoningDelta?: (delta: string) => void;
  thinking?: ReasoningRequest;
  cache?: CacheHints;
}

export interface StreamResult {
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason: string | null;
  usage?: LlmUsage;
  // The turn's reasoning as display text (both providers), when the model produced any. Null/absent → no reasoning.
  reasoning?: string;
  // Provider-native reasoning blocks (Anthropic thinking / redacted_thinking, with signatures) needed to replay the
  // turn's thinking on the FOLLOWING tool-result call. Opaque to the kernel — it carries them back verbatim via the
  // message side-channel (ReasoningCarrier); the Anthropic transport re-emits them, OpenAI ignores them (stateless).
  reasoningBlocks?: unknown[];
}

// One assistant turn's captured reasoning, attached to the assistant message the kernel keeps in its working history:
// `text` is the display/persistence form; `blocks` are the provider-native thinking blocks re-sent on the next call so
// Anthropic's "preserve the thinking block when tool use follows thinking" constraint holds within a turn.
export interface ReasoningTrace {
  text: string;
  blocks?: unknown[];
}

export interface ReasoningCarrier {
  reasoning?: ReasoningTrace;
}

// A provider-native transport: translate the canonical request to the provider's API (message protocol, tool format,
// prompt caching), and normalize the reply. `stream` powers the agent loop (live token deltas). `complete` is the
// one-shot, non-streaming variant for callers that only want the final text (model judges, connection probes, the
// compaction summariser) — same request/result shape, no streaming. Optional so a fake transport can implement only
// what it exercises; callers that want a one-shot fall back to `stream` when it's absent.
export interface LlmTransport {
  readonly provider: string;
  stream(req: StreamRequest): Promise<StreamResult>;
  complete?(req: StreamRequest): Promise<StreamResult>;
}
