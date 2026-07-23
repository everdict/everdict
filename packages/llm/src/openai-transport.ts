import type OpenAI from "openai";
import type { LlmTool, LlmToolCall, LlmTransport, LlmUsage, StreamRequest, StreamResult } from "./transport.js";

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
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

// Native OpenAI Chat Completions transport (also serves any OpenAI-compatible endpoint — vLLM, a LiteLLM proxy, … —
// via a custom baseURL on the injected client). Streams content deltas + accumulates tool-call fragments into the
// canonical StreamResult.
export class OpenAiTransport implements LlmTransport {
  readonly provider = "openai";

  constructor(private readonly client: OpenAI) {}

  async stream(req: StreamRequest): Promise<StreamResult> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: req.system },
      ...req.messages,
    ];
    const tools = toOpenAiTools(req.tools);
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

    let content = "";
    const toolCalls = new Map<number, AccumulatedToolCall>();
    let finishReason: string | null = null;
    let usage: OpenAI.Completions.CompletionUsage | undefined;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      if (delta?.content) {
        content += delta.content;
        req.onContentDelta?.(delta.content);
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

    const orderedToolCalls: LlmToolCall[] = Array.from(toolCalls.entries())
      .sort(([a], [b]) => a - b)
      .map(([, c]) => c)
      .filter((c) => c.id.length > 0 && c.name.length > 0);

    return {
      content: content.length > 0 ? content : null,
      toolCalls: orderedToolCalls,
      finishReason,
      usage: normalizeUsage(usage),
    };
  }

  // One-shot, non-streaming completion (judges / probes) — same request, the final message instead of token deltas.
  async complete(req: StreamRequest): Promise<StreamResult> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: req.system },
      ...req.messages,
    ];
    const tools = toOpenAiTools(req.tools);
    const res = await this.client.chat.completions.create(
      {
        model: req.model,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        stream: false,
      },
      req.signal ? { signal: req.signal } : undefined,
    );
    const choice = res.choices[0];
    const toolCalls: LlmToolCall[] = (choice?.message.tool_calls ?? [])
      .filter(
        (tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & { type: "function" } =>
          tc.type === "function",
      )
      .map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
    return {
      content: choice?.message.content ?? null,
      toolCalls,
      finishReason: choice?.finish_reason ?? null,
      usage: normalizeUsage(res.usage),
    };
  }
}
