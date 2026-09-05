// The composer's prompt history — a reinterpretation of Claude Code's global `history.jsonl` (↑/↓ recall a message sent earlier).
// It lives in browser storage for two reasons: the panel unmounts when you move to another infra tab, so component state would not survive,
// and history is "what have I asked the agent to do" rather than "what did I say in this conversation", so it has to cross session boundaries.
// Newest first (index 0 = most recent) — so the first ↑ is the previous message.

const STORAGE_KEY = 'everdict:agent-chat:prompt-history'
const MAX_ENTRIES = 100

// The cursor: index 0 = the draft being written (not yet in history), index N = viewing history entry N-1.
// `draft` is the draft at the moment ↑ was first pressed — coming back with ↓ restores it (Claude Code's lastShownHistoryEntry).
export interface PromptHistoryCursor {
  index: number
  draft: string
}

// The result of one move. The caret is decided by the DIRECTION: ↑ puts it at the very start (so the next ↑ is not eaten by cursor movement),
// ↓ at the very end (the posture for carrying on typing).
export interface PromptHistoryStep {
  cursor: PromptHistoryCursor
  value: string
  caret: 'start' | 'end'
}

export const EMPTY_PROMPT_HISTORY_CURSOR: PromptHistoryCursor = { index: 0, draft: '' }

export function readPromptHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch {
    // In a browser that cannot read storage (private mode, etc.) it is the same as having no history — the input still works.
    return []
  }
}

// Push a sent prompt onto the front. An identical string to the one before it is not pushed (having to press ↑ twice after sending the same
// thing twice is noise, not history).
export function pushPromptHistory(text: string): void {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  try {
    const existing = readPromptHistory()
    if (existing[0] === trimmed) return
    const next = [trimmed, ...existing.filter((entry) => entry !== trimmed)].slice(0, MAX_ENTRIES)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // A storage failure is no reason to block the input — only this one prompt fails to make it into the history.
  }
}

// One step ↑. With nowhere further up it returns null (leaving the input untouched — Claude Code stops while preserving the draft too).
export function promptHistoryUp(
  cursor: PromptHistoryCursor,
  entries: string[],
  current: string
): PromptHistoryStep | null {
  const target = cursor.index
  const entry = entries[target]
  if (entry === undefined) return null
  // The draft is captured ONCE, at the value it had the moment history navigation started.
  const draft = target === 0 ? current : cursor.draft
  return { cursor: { index: target + 1, draft }, value: entry, caret: 'start' }
}

// One step ↓. Coming down from index 1 restores the captured draft, and going further down from the draft position (0) returns null —
// telling the caller "this is the floor" so it can use that key for something else.
export function promptHistoryDown(
  cursor: PromptHistoryCursor,
  entries: string[]
): PromptHistoryStep | null {
  if (cursor.index > 1) {
    const entry = entries[cursor.index - 2]
    if (entry === undefined) return null
    return { cursor: { index: cursor.index - 1, draft: cursor.draft }, value: entry, caret: 'end' }
  }
  if (cursor.index === 1)
    return { cursor: EMPTY_PROMPT_HISTORY_CURSOR, value: cursor.draft, caret: 'end' }
  return null
}

// Whether ↑/↓ may move the history at all: in a multi-line input the caret has to move between lines first, and only on reaching the first or
// last line is it history's turn (Claude Code's isCursorOnFirstLine/isCursorOnLastLine).
export function isCaretOnFirstLine(value: string, caret: number): boolean {
  return value.lastIndexOf('\n', caret - 1) === -1
}

export function isCaretOnLastLine(value: string, caret: number): boolean {
  return value.indexOf('\n', caret) === -1
}
