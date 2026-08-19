import { AppError, UpstreamError } from "@everdict/contracts";
import type OpenAI from "openai";
import type {
  LlmMessage,
  LlmTool,
  LlmToolCall,
  LlmTransport,
  LlmUsage,
  StreamRequest,
  StreamResult,
} from "./transport.js";

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

// The kernel may attach a `reasoning` side-channel to assistant messages (for Anthropic thinking replay). OpenAI chat
// completions are stateless w.r.t. reasoning, and the extra key would be an unexpected field on the request — strip it.
function stripReasoning(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((m) => {
    if (!("reasoning" in m)) return m;
    const { reasoning: _reasoning, ...rest } = m as LlmMessage & { reasoning?: unknown };
    return rest as LlmMessage;
  });
}

// Reasoning models over an OpenAI-compatible endpoint (LiteLLM/DeepSeek/…) surface the chain-of-thought under a
// non-standard field — `reasoning_content` (most) or `reasoning` (some). Read whichever is a string.
function reasoningTextOf(o: unknown): string | undefined {
  if (o === null || typeof o !== "object") return undefined;
  const r = o as { reasoning_content?: unknown; reasoning?: unknown };
  if (typeof r.reasoning_content === "string") return r.reasoning_content;
  if (typeof r.reasoning === "string") return r.reasoning;
  return undefined;
}

function toOpenAiTools(tools: LlmTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parametersJsonSchema },
  }));
}

// OpenAI reports prompt-cache hits under prompt_tokens_details.cached_tokens (automatic prefix caching — no cache_control
// needed, so CacheHints is a no-op here; keeping the prefix stable is what earns the discount).
function normalizeUsage(usage: OpenAI.Completions.CompletionUsage | undefined): LlmUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(typeof cached === "number" ? { cacheReadTokens: cached } : {}),
  };
}

// How much of the provider's own error body is kept on the remapped error. Enough for a 429 to name WHICH limit was
// hit (LiteLLM/OpenAI answer with a JSON body carrying the type + reset), short enough to stay a message.
const ERROR_BODY_LIMIT = 300;

// The SDK's APIError carries the response headers as a plain (case-insensitively proxied) record, not a Headers
// instance — read `retry-after` (seconds or an HTTP date) out of it as the server's own pacing.
function retryAfterMsOfHeaders(headers: unknown, nowMs = Date.now()): number | undefined {
  if (headers === null || typeof headers !== "object") return undefined;
  const raw = (headers as Record<string, unknown>)["retry-after"];
  if (typeof raw !== "string") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs) && dateMs > nowMs) return dateMs - nowMs;
  return undefined;
}

// Remap the SDK's own failures to our error model (the repo rule: an external failure never propagates raw). Two
// things ride along in `extra` because the caller's retry policy classifies on them rather than on a message regex:
// the provider's HTTP `status` and its `retryAfterMs`. The provider's body stays in the MESSAGE — a 429 that says
// "usage limit reached, resets in 14 days" is the whole answer for the member, and burying it turns every upstream
// failure into an indistinguishable "the model provider call failed".
function remapProviderError(err: unknown): never {
  if (err instanceof AppError) throw err; // already ours (a nested transport / our own guard)
  const status = (err as { status?: unknown }).status;
  const httpStatus = typeof status === "number" ? status : undefined;
  const retryAfterMs = retryAfterMsOfHeaders((err as { headers?: unknown }).headers);
  // The SDK's own message truncates the body to its `message` field; the parsed body (`error`) carries the rest —
  // the limit type, the plan, when it resets — which is the difference between "429" and an answer.
  const body = (err as { error?: unknown }).error;
  const detail =
    body !== null && typeof body === "object" ? JSON.stringify(body) : err instanceof Error ? err.message : String(err);
  throw new UpstreamError(
    "UPSTREAM_ERROR",
    {
      ...(httpStatus !== undefined ? { status: httpStatus } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    },
    httpStatus !== undefined
      ? `model ${httpStatus}: ${detail.slice(0, ERROR_BODY_LIMIT)}`
      : `model call failed: ${detail.slice(0, ERROR_BODY_LIMIT)}`,
  );
}

// Native OpenAI Chat Completions transport (also serves any OpenAI-compatible endpoint — vLLM, a LiteLLM proxy, … —
// via a custom baseURL on the injected client). Streams content deltas + accumulates tool-call fragments into the
// canonical StreamResult.
export class OpenAiTransport implements LlmTransport {
  readonly provider = "openai";

  constructor(private readonly client: OpenAI) {}

  async stream(req: StreamRequest): Promise<StreamResult> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: req.system },
      ...stripReasoning(req.messages),
    ];
    const tools = toOpenAiTools(req.tools);
    let content = "";
    let reasoning = "";
    const toolCalls = new Map<number, AccumulatedToolCall>();
    let finishReason: string | null = null;
    let usage: OpenAI.Completions.CompletionUsage | undefined;

    // The request AND the stream iteration share one remap: a provider failure surfaces mid-stream just as often as
    // it does on the initial call (a 429 on a retried upstream leg, a proxy dropping the body).
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: req.model,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        req.signal ? { signal: req.signal } : undefined,
      );

      for await (const chunk of stream) {
        // `choices` itself can be absent, not merely empty — a gateway's usage-only chunk or an error envelope
        // returned with a 200. Indexing it directly threw a TypeError that surfaced as a grader/agent crash
        // instead of the missing-choice case every line below already handles.
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          content += delta.content;
          req.onContentDelta?.(delta.content);
        }
        const reasoningDelta = reasoningTextOf(delta);
        if (reasoningDelta !== undefined && reasoningDelta.length > 0) {
          reasoning += reasoningDelta;
          req.onReasoningDelta?.(reasoningDelta);
        }
        if (delta?.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index;
            if (typeof idx !== "number") continue;
            let acc = toolCalls.get(idx);
            if (!acc) {
              acc = { id: tcDelta.id ?? "", name: "", arguments: "" };
              toolCalls.set(idx, acc);
            }
            if (tcDelta.id) acc.id = tcDelta.id;
            if (tcDelta.function?.name) acc.name = tcDelta.function.name;
            if (tcDelta.function?.arguments) acc.arguments += tcDelta.function.arguments;
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (err) {
      remapProviderError(err);
    }

    const orderedToolCalls: LlmToolCall[] = Array.from(toolCalls.entries())
      .sort(([a], [b]) => a - b)
      .map(([, c]) => c)
      .filter((c) => c.id.length > 0 && c.name.length > 0);

    return {
      content: content.length > 0 ? content : null,
      toolCalls: orderedToolCalls,
      finishReason,
      usage: normalizeUsage(usage),
      ...(reasoning.length > 0 ? { reasoning } : {}),
    };
  }

  // One-shot, non-streaming completion (judges / probes) — same request, the final message instead of token deltas.
  async complete(req: StreamRequest): Promise<StreamResult> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: req.system },
      ...stripReasoning(req.messages),
    ];
    const tools = toOpenAiTools(req.tools);
    const res = await this.client.chat.completions
      .create(
        {
          model: req.model,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
          stream: false,
        },
        req.signal ? { signal: req.signal } : undefined,
      )
      .catch((err: unknown) => remapProviderError(err));
    const choice = res.choices?.[0];
    const toolCalls: LlmToolCall[] = (choice?.message.tool_calls ?? [])
      .filter(
        (tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & { type: "function" } =>
          tc.type === "function",
      )
      .map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
    const reasoning = reasoningTextOf(choice?.message);
    return {
      content: choice?.message.content ?? null,
      toolCalls,
      finishReason: choice?.finish_reason ?? null,
      usage: normalizeUsage(res.usage),
      ...(reasoning !== undefined && reasoning.length > 0 ? { reasoning } : {}),
    };
  }
}
