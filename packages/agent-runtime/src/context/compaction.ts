import type { ChatMessage } from "../messages.js";

// First-cut structural compaction: when over budget, drop the oldest turns but only up to a clean boundary — a
// `user` message — so the kept suffix never begins with an orphan `tool` result whose assistant tool_call was
// dropped (which would make the next LLM call reject). Returns the same array when it cannot safely trim.
// LLM-summary compaction (preserving a digest of the dropped span) is a later enhancement.
export function compactMessages(messages: ChatMessage[], recentKeep = 8): ChatMessage[] {
  if (messages.length <= recentKeep) return messages;
  const dropUpTo = messages.length - recentKeep;
  for (let i = dropUpTo; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      return i > 0 ? messages.slice(i) : messages;
    }
  }
  return messages;
}
