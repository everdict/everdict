import type OpenAI from "openai";

// The kernel speaks OpenAI's chat message shape directly: it is what streamChat sends and what tool-call
// pairing (assistant.tool_calls ↔ tool.tool_call_id) is expressed in.
export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
