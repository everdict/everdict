import type OpenAI from "openai";

// The kernel speaks OpenAI's chat message shape directly: it is what streamChat sends and what tool-call
// pairing (assistant.tool_calls ↔ tool.tool_call_id) is expressed in. Host code builds turns via the helpers.
export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function systemMessage(content: string): ChatMessage {
  return { role: "system", content };
}

export function userMessage(content: string): ChatMessage {
  return { role: "user", content };
}

export function assistantText(content: string): ChatMessage {
  return { role: "assistant", content };
}

export function toolMessage(toolCallId: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: toolCallId, content };
}
