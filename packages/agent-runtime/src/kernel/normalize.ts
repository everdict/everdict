import type { ChatMessage } from "../messages.js";

// A lone half of a UTF-16 surrogate pair — produced when a code-unit slice cuts an emoji/CJK-extension in two.
// Providers reject request bodies carrying them, so any truncation whose output reaches the wire repairs with this.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Replace lone surrogates with U+FFFD (String.prototype.toWellFormed, reimplemented — the repo targets ES2023).
export function toWellFormedText(text: string): string {
  return text.replace(LONE_SURROGATE, "�");
}

// A tool call's `arguments` is the raw string the model emitted, and the OpenAI wire re-sends it VERBATIM on every
// later request — so one malformed fragment (a turn cut at the token cap, a small model emitting prose) makes the
// provider reject every subsequent call: the conversation is permanently bricked. Anything that stores or replays a
// tool call runs its arguments through here first: well-formed parseable JSON passes byte-identical (fidelity),
// lone surrogates are repaired in place, and anything unparseable becomes "{}" — the same substitution the
// Anthropic transport already applies implicitly on its wire.
export function wellFormedArguments(raw: string): string {
  const repaired = toWellFormedText(raw);
  if (repaired.trim().length === 0) return "{}";
  try {
    JSON.parse(repaired);
  } catch {
    return "{}";
  }
  return repaired;
}

function repairToolCallArguments(m: ChatMessage): ChatMessage {
  if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) return m;
  const needsRepair = m.tool_calls.some(
    (c) => c.type === "function" && wellFormedArguments(c.function.arguments) !== c.function.arguments,
  );
  if (!needsRepair) return m;
  return {
    ...m,
    tool_calls: m.tool_calls.map((c) =>
      c.type === "function"
        ? { ...c, function: { ...c.function, arguments: wellFormedArguments(c.function.arguments) } }
        : c,
    ),
  };
}

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
// reinterpreted). Four repairs — three structural, one content:
//   1. drop degenerate assistant messages (no text, no tool_calls) — they waste a turn / confuse the provider;
//   2. PAIRING: every assistant tool_call must be answered before the next non-tool message — a crash mid-turn
//      persists the assistant's tool_calls but not the results, and replaying that dangling transcript makes the
//      provider reject EVERY subsequent call (the conversation is permanently bricked). Missing results get a
//      synthetic placeholder; the conversation lives on.
//   3. drop orphan tool results (no preceding assistant call awaiting that id) — equally rejected by providers.
//   4. ARGUMENTS: a tool_call whose raw `arguments` is not well-formed JSON is replayed as "{}" — the OpenAI wire
//      re-sends the string verbatim, so a fragment persisted before this repair existed bricks the conversation
//      the same way a dangling pair does. Running it here (the send-time projection) heals already-poisoned
//      transcripts instead of requiring their deletion.
// The transcript is otherwise trusted (built by the kernel with correct tool-call pairing).
export function normalizeHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const raw = messages[i];
    const m = raw === undefined ? raw : repairToolCallArguments(raw);
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
