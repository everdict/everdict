import type { ChatMessage } from "../messages.js";

function isEmptyAssistant(m: ChatMessage): boolean {
  if (m.role !== "assistant") return false;
  const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  const hasText = typeof m.content === "string" && m.content.trim().length > 0;
  return !hasToolCalls && !hasText;
}

// Synthetic tool-result content inserted when an assistant tool_call has no persisted result (the host crashed or
// the run was killed mid-turn before the tool settled). Structural repair only — the content says plainly that the
// call never completed, so the model treats it as not executed rather than inventing an outcome.
export const SYNTHETIC_TOOL_RESULT =
  "[Tool result missing — the run was interrupted before this tool call completed. Treat the call as not executed.]";

// Normalize a replayed transcript into one the provider will accept (Claude Code's ensureToolResultPairing,
// reinterpreted). Three repairs, all structural:
//   1. drop degenerate assistant messages (no text, no tool_calls) — they waste a turn / confuse the provider;
//   2. PAIRING: every assistant tool_call must be answered before the next non-tool message — a crash mid-turn
//      persists the assistant's tool_calls but not the results, and replaying that dangling transcript makes the
//      provider reject EVERY subsequent call (the conversation is permanently bricked). Missing results get a
//      synthetic placeholder; the conversation lives on.
//   3. drop orphan tool results (no preceding assistant call awaiting that id) — equally rejected by providers.
// The transcript is otherwise trusted (built by the kernel with correct tool-call pairing).
export function normalizeHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m || isEmptyAssistant(m)) {
      i += 1;
      continue;
    }
    // An orphan tool result reaching here has no assistant awaiting it (paired ones are consumed below) — drop.
    if (m.role === "tool") {
      i += 1;
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      out.push(m);
      const unanswered = new Set(m.tool_calls.map((c) => c.id));
      i += 1;
      // Consume the run of tool results answering THIS turn; a duplicate/foreign id inside the run is dropped.
      while (i < messages.length) {
        const t = messages[i];
        if (!t || t.role !== "tool") break;
        if (unanswered.has(t.tool_call_id)) {
          out.push(t);
          unanswered.delete(t.tool_call_id);
        }
        i += 1;
      }
      // Repair: answer every still-unanswered call with a synthetic result, in the assistant's call order.
      for (const call of m.tool_calls) {
        if (unanswered.has(call.id)) {
          out.push({ role: "tool", tool_call_id: call.id, content: SYNTHETIC_TOOL_RESULT });
        }
      }
      continue;
    }
    out.push(m);
    i += 1;
  }
  return out;
}
