import type { ChatMessage } from "../messages.js";
import { READ_SKILL_FILE_TOOL_NAME, USE_SKILL_TOOL_NAME } from "../tools/skill-tool.js";

// Context compaction — a 3-rung escalation ladder that raises tokens-per-information instead of just discarding the
// oldest turns (Claude Code parity). The loop applies them in order until it fits:
//   1. microcompact  — deterministic: clear OLD tool-result BODIES (keep tool_call_id + pairing), ~free tokens back.
//   2. summarize     — semantic: an LLM digest of the old span (goal/files/pending preserved), keep the recent tail.
//   3. structural    — last resort: drop the oldest turns to a clean user boundary (the original behaviour).
// Each is a pure transform (summarize takes an injected async summariser); the loop owns the ordering + budget check.

const CLEARED_MARK = "[tool result elided to fit the context window";
const DEFAULT_RECENT_KEEP = 8;
// Clearing a tiny result isn't worth the churn (and would thrash the prompt cache); only elide sizeable ones.
const MIN_CLEAR_CHARS = 400;
// Loaded skill payloads (use_skill / read_skill_file results) are ACTIVE guidance, not stale output — the agent may
// still be mid-procedure. Keep them across microcompact within a budget, most recent first (Claude Code re-emits
// invoked skills post-compact under a similar budget); beyond the budget they clear like any other result.
const SKILL_KEEP_BUDGET_CHARS = 24_000;
const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set([USE_SKILL_TOOL_NAME, READ_SKILL_FILE_TOOL_NAME]);

// Providers cap the number of media items in ONE request (Anthropic: 100) and reject the whole request past it with
// an error that says nothing useful. A screenshot-driven run (browser / os-use) crosses that cap on its own, and
// because the images live in the durable history the retry fails identically — the run cannot get out.
const MAX_MEDIA_PER_REQUEST = 100;
const DROPPED_IMAGE_MARK = "[older image dropped to stay under the provider's per-request media limit]";

function imagePartCount(m: ChatMessage): number {
  if (!Array.isArray(m.content)) return 0;
  let n = 0;
  for (const p of m.content) if (typeof p === "object" && p !== null && "image_url" in p) n++;
  return n;
}

// Cap the media items in ONE outbound request, oldest-first — applied at the REQUEST-BUILD boundary and never to
// the stored history, so the trace keeps every screenshot while the wire payload stays legal. Recomputed per
// request (cheap: a scan of the content arrays), which is what lets it stay purely ephemeral: nothing to undo,
// and a later compaction that removes old turns automatically restores the dropped images' budget.
// The newest images are the ones an agent is acting on, so the oldest go first — with a text mark in their place
// rather than silent removal, because "there was an image here" is what stops the model re-reading a stale one.
export function capMedia(messages: ChatMessage[], max = MAX_MEDIA_PER_REQUEST): ChatMessage[] {
  let total = 0;
  for (const m of messages) total += imagePartCount(m);
  let over = total - max;
  if (over <= 0) return messages;
  const out = [...messages];
  for (let i = 0; i < out.length && over > 0; i++) {
    const m = out[i];
    if (!m || imagePartCount(m) === 0) continue;
    const parts: unknown[] = [];
    for (const p of m.content as unknown[]) {
      if (over > 0 && typeof p === "object" && p !== null && "image_url" in p) {
        over--;
        parts.push({ type: "text", text: DROPPED_IMAGE_MARK });
      } else {
        parts.push(p);
      }
    }
    out[i] = { ...m, content: parts } as ChatMessage;
  }
  return out;
}

// tool_call_ids of skill-tool invocations — found on the assistant turns (a tool message carries no tool name).
function skillToolCallIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const call of m.tool_calls) {
      if (call.type === "function" && SKILL_TOOL_NAMES.has(call.function.name)) ids.add(call.id);
    }
  }
  return ids;
}

// Rung 1 — clear the CONTENT of tool messages older than the recent window, keeping role + tool_call_id so the
// assistant.tool_calls ↔ tool pairing stays valid (the next model call must still see a balanced transcript). Already
// cleared / small results are left as-is; loaded-skill results survive within SKILL_KEEP_BUDGET_CHARS (newest first).
// Returns the (possibly new) array + how many bodies were cleared.
export function microcompact(
  messages: ChatMessage[],
  recentKeep = DEFAULT_RECENT_KEEP,
): { messages: ChatMessage[]; cleared: number } {
  if (messages.length <= recentKeep) return { messages, cleared: 0 };
  const cutoff = messages.length - recentKeep;
  const skillIds = skillToolCallIds(messages);
  // Skill results to retain within the budget — newest first; older ones beyond it clear like any other result.
  const keptSkillIndexes = new Set<number>();
  let skillBudget = SKILL_KEEP_BUDGET_CHARS;
  for (let i = cutoff - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "tool" || !skillIds.has(m.tool_call_id)) continue;
    const length = typeof m.content === "string" ? m.content.length : 0;
    if (length > skillBudget) continue;
    skillBudget -= length;
    keptSkillIndexes.add(i);
  }
  let cleared = 0;
  const out = messages.map((m, i): ChatMessage => {
    if (i >= cutoff || m.role !== "tool" || keptSkillIndexes.has(i)) return m;
    const content = typeof m.content === "string" ? m.content : "";
    if (content.length < MIN_CLEAR_CHARS || content.startsWith(CLEARED_MARK)) return m;
    cleared++;
    return { ...m, content: `${CLEARED_MARK} — was ${content.length} chars]` };
  });
  return { messages: out, cleared };
}

// Rung 3 — structural drop to a clean `user` boundary (kept as the final fallback). Returns the same array when it
// cannot safely trim (never leaves the suffix starting on an orphan tool result).
export function compactMessages(messages: ChatMessage[], recentKeep = DEFAULT_RECENT_KEEP): ChatMessage[] {
  if (messages.length <= recentKeep) return messages;
  const dropUpTo = messages.length - recentKeep;
  for (let i = dropUpTo; i < messages.length; i++) {
    if (messages[i]?.role === "user") return i > 0 ? messages.slice(i) : messages;
  }
  return messages;
}

// The escalation ladder as one step, shared by the loop's proactive (over-budget) path AND its reactive (413 /
// context-overflow) recovery path. Tries the cheapest, most information-preserving rung first and returns the first
// that shrinks the context; `mode: null` means nothing could be reclaimed (the caller stops / rethrows). A summariser
// failure (upstream error) falls through to the structural drop rather than crashing the run.
export async function compactStep(
  messages: ChatMessage[],
  summarize: (oldSpan: ChatMessage[]) => Promise<string>,
): Promise<{ messages: ChatMessage[]; mode: "microcompact" | "summarize" | "drop" | null; dropped: number }> {
  // Rung 1: clear old tool-result bodies (deterministic; frees tokens without dropping any turn).
  const micro = microcompact(messages);
  if (micro.cleared > 0) return { messages: micro.messages, mode: "microcompact", dropped: 0 };
  // Rung 2: LLM digest of the old span (goal/pending preserved).
  let summarized = messages;
  try {
    summarized = await summarizeAndCompact(messages, summarize);
  } catch {
    summarized = messages;
  }
  if (summarized.length < messages.length) {
    return { messages: summarized, mode: "summarize", dropped: messages.length - summarized.length };
  }
  // Rung 3: structural drop to a clean user boundary (last resort).
  const dropped = compactMessages(messages);
  if (dropped.length < messages.length) {
    return { messages: dropped, mode: "drop", dropped: messages.length - dropped.length };
  }
  return { messages, mode: null, dropped: 0 };
}

// Rung 2 — replace the old span with an LLM digest, keep the recent tail from a clean user boundary. The digest is a
// synthetic user message the model reads as context (Intent/Files/Errors/Pending/Current-Work survive the boundary).
// Returns the same array when no safe boundary exists (so the loop falls through to structural drop).
export async function summarizeAndCompact(
  messages: ChatMessage[],
  summarize: (oldSpan: ChatMessage[]) => Promise<string>,
  recentKeep = DEFAULT_RECENT_KEEP,
): Promise<ChatMessage[]> {
  if (messages.length <= recentKeep) return messages;
  const dropUpTo = messages.length - recentKeep;
  let boundary = -1;
  for (let i = dropUpTo; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      boundary = i;
      break;
    }
  }
  if (boundary <= 0) return messages; // nothing safe to summarise (keep everything; loop escalates/stops)
  const oldSpan = messages.slice(0, boundary);
  const tail = messages.slice(boundary);
  const digest = (await summarize(oldSpan)).trim();
  if (digest.length === 0) return messages; // summariser produced nothing — don't drop context blindly
  const summaryMessage: ChatMessage = {
    role: "user",
    content: `[The earlier part of this conversation was summarised to fit the context window. Continue from here.]\n\n${digest}`,
  };
  return [summaryMessage, ...tail];
}
