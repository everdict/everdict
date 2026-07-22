import type { ChatMessage } from "../messages.js";

function isEmptyAssistant(m: ChatMessage): boolean {
  if (m.role !== "assistant") return false;
  const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  const hasText = typeof m.content === "string" && m.content.trim().length > 0;
  return !hasToolCalls && !hasText;
}

// Drop degenerate assistant messages (no text, no tool_calls) that would otherwise waste a turn or confuse the
// provider. The transcript is otherwise trusted (built by the kernel with correct tool-call pairing).
export function normalizeHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => !isEmptyAssistant(m));
}
