// 컴포저의 프롬프트 히스토리 — Claude Code 의 전역 `history.jsonl` 재해석(↑/↓ 로 이전에 보낸 메시지를 다시 꺼낸다).
// 브라우저 저장소에 사는 이유는 둘: 패널은 다른 인프라 탭으로 가면 언마운트되므로 컴포넌트 상태로는 살아남지 못하고,
// 히스토리는 "이 대화에서 뭘 말했나"가 아니라 "내가 에이전트에게 무엇을 시켜 왔나"라서 세션 경계를 넘어야 한다.
// 최신이 먼저(index 0 = 가장 최근) — 첫 ↑ 가 곧 직전 메시지다.

const STORAGE_KEY = 'everdict:agent-chat:prompt-history'
const MAX_ENTRIES = 100

// 커서: index 0 = 지금 쓰던 초안(아직 히스토리에 들어가지 않은 것), index N = 히스토리의 N-1 번째를 보고 있는 상태.
// draft 는 첫 ↑ 를 누른 순간의 초안 — ↓ 로 돌아오면 그대로 복원된다(Claude Code 의 lastShownHistoryEntry).
export interface PromptHistoryCursor {
  index: number
  draft: string
}

// 한 번의 이동 결과. caret 은 이동 방향이 정한다: ↑ 는 맨 앞(다음 ↑ 가 커서 이동에 먹히지 않도록),
// ↓ 는 맨 뒤(이어서 타이핑하는 자세).
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
    // 저장소를 못 읽는 브라우저(프라이빗 모드 등)에서는 히스토리가 없는 것과 같다 — 입력은 그대로 동작한다.
    return []
  }
}

// 전송한 프롬프트를 맨 앞에 쌓는다. 바로 앞과 같은 문자열이면 쌓지 않는다(같은 걸 두 번 보낸 뒤 ↑ 를 두 번
// 눌러야 하는 건 히스토리가 아니라 잡음).
export function pushPromptHistory(text: string): void {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  try {
    const existing = readPromptHistory()
    if (existing[0] === trimmed) return
    const next = [trimmed, ...existing.filter((entry) => entry !== trimmed)].slice(0, MAX_ENTRIES)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 저장 실패는 입력을 막을 이유가 못 된다 — 이번 프롬프트만 히스토리에 남지 않는다.
  }
}

// ↑ 한 칸. 더 올라갈 데가 없으면 null(입력은 건드리지 않고 그대로 둔다 — Claude Code 도 초안을 지키며 멈춘다).
export function promptHistoryUp(
  cursor: PromptHistoryCursor,
  entries: string[],
  current: string
): PromptHistoryStep | null {
  const target = cursor.index
  const entry = entries[target]
  if (entry === undefined) return null
  // 초안은 히스토리 탐색을 시작한 그 순간의 값으로 한 번만 붙잡는다.
  const draft = target === 0 ? current : cursor.draft
  return { cursor: { index: target + 1, draft }, value: entry, caret: 'start' }
}

// ↓ 한 칸. index 1 에서 내려오면 붙잡아 둔 초안으로 복귀하고, 초안 자리(0)에서 더 내리면 null —
// 호출자가 그 키를 다른 용도로 쓸 수 있게 "여기가 바닥"임을 알린다.
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

// ↑/↓ 가 히스토리를 움직여도 되는지: 여러 줄 입력에서는 커서가 먼저 줄을 오르내려야 하고, 첫 줄/마지막 줄에
// 닿았을 때만 히스토리 차례다(Claude Code 의 isCursorOnFirstLine/isCursorOnLastLine).
export function isCaretOnFirstLine(value: string, caret: number): boolean {
  return value.lastIndexOf('\n', caret - 1) === -1
}

export function isCaretOnLastLine(value: string, caret: number): boolean {
  return value.indexOf('\n', caret) === -1
}
