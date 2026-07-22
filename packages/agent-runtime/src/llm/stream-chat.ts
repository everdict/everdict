import type OpenAI from "openai";

export interface StreamChatOptions {
  client: OpenAI;
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  temperature?: number;
  signal?: AbortSignal;
  onContentDelta?: (delta: string) => void;
}

export interface StreamChatResult {
  content: string | null;
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  finishReason: string | null;
  usage: OpenAI.Completions.CompletionUsage | undefined;
}

interface AccumulatedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// Streaming wrapper around chat.completions.create({ stream: true }). Accumulates content + tool_call fragments
// into the shape a non-streaming call would return, while firing onContentDelta per chunk so the host can pipe
// tokens through SSE.
export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  const stream = await opts.client.chat.completions.create(
    {
      model: opts.model,
      messages: opts.messages,
      ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      stream: true,
      stream_options: { include_usage: true },
    },
    opts.signal ? { signal: opts.signal } : undefined,
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
      opts.onContentDelta?.(delta.content);
    }
    if (delta?.tool_calls) {
      for (const tcDelta of delta.tool_calls) {
        const idx = tcDelta.index;
        if (typeof idx !== "number") continue;
        let acc = toolCalls.get(idx);
        if (!acc) {
          acc = { id: tcDelta.id ?? "", type: "function", function: { name: "", arguments: "" } };
          toolCalls.set(idx, acc);
        }
        if (tcDelta.id) acc.id = tcDelta.id;
        if (tcDelta.function?.name) acc.function.name = tcDelta.function.name;
        if (tcDelta.function?.arguments) acc.function.arguments += tcDelta.function.arguments;
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }

  const orderedToolCalls = Array.from(toolCalls.entries())
    .sort(([a], [b]) => a - b)
    .map(([, c]) => c)
    .filter((c) => c.id.length > 0 && c.function.name.length > 0);

  return {
    content: content.length > 0 ? content : null,
    toolCalls: orderedToolCalls,
    finishReason,
    usage,
  };
}
