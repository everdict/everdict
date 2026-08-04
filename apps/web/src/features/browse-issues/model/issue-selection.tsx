'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

// 목록에서 여러 이슈를 한꺼번에 고르기. 스코어카드 목록·파일 트리와 같은 문법이다(호버로 드러나는 체크박스,
// shift-클릭 범위, 고르는 중에는 클릭이 열지 않고 토글, Esc 로 해제, 화면 아래 떠 있는 액션 바).
//
// 선택은 **저장하지 않는다** — 스코어카드 목록은 sessionStorage 에 남기지만, 이슈 목록은 필터·묶기·정렬이
// 전부 URL 이라 뒤로 가기 한 번이면 화면이 통째로 바뀐다. 그때까지 살아남은 선택은 "무엇을 고른 건지"를
// 사람이 답할 수 없는 상태가 된다.
//
// 범위 선택의 순서는 **DOM 순서**로 푼다. 그룹이 「더 보기」로 행을 클라이언트에서 이어 붙이기 때문에
// 서버가 준 목록은 화면과 어긋날 수 있고, shift-클릭이 뜻하는 것은 언제나 "보이는 이 줄부터 저 줄까지"다.
export const ISSUE_ROW_ATTR = 'data-issue-id'

interface IssueSelectionValue {
  selected: ReadonlySet<string>
  // 하나라도 골라져 있으면 목록 전체가 「고르는 중」이 된다 — 그때는 행 클릭이 이슈를 열지 않고 토글한다.
  selectionMode: boolean
  toggle: (id: string, shiftKey: boolean) => void
  clear: () => void
}

const Ctx = createContext<IssueSelectionValue | null>(null)

function visibleIds(): string[] {
  if (typeof document === 'undefined') return []
  return [...document.querySelectorAll(`[${ISSUE_ROW_ATTR}]`)]
    .map((el) => el.getAttribute(ISSUE_ROW_ATTR))
    .filter((id): id is string => id !== null)
}

export function IssueSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  // 마지막으로 토글한 행 — shift-클릭의 한쪽 끝. id 로 들고 있어야 필터가 바뀌어도 엉뚱한 범위를 잡지 않는다.
  const anchorRef = useRef<string | null>(null)

  const toggle = useCallback((id: string, shiftKey: boolean) => {
    const anchor = anchorRef.current
    if (shiftKey && anchor !== null && anchor !== id) {
      const order = visibleIds()
      const from = order.indexOf(anchor)
      const to = order.indexOf(id)
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        const range = order.slice(lo, hi + 1)
        setSelected((prev) => new Set([...prev, ...range]))
        anchorRef.current = id
        return
      }
      // 앵커가 화면에서 사라졌으면(필터·접기) 범위를 지어낼 수 없다 — 평범한 토글로 떨어진다.
    }
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    anchorRef.current = id
  }, [])

  const clear = useCallback(() => {
    setSelected(new Set())
    anchorRef.current = null
  }, [])

  const selectionMode = selected.size > 0

  // Esc 는 선택을 버린다. 고르는 중이 아닐 때는 듣지 않는다 — 다른 화면의 Esc(다이얼로그 닫기)를 가로채면 안 된다.
  useEffect(() => {
    if (!selectionMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectionMode, clear])

  const value = useMemo<IssueSelectionValue>(
    () => ({ selected, selectionMode, toggle, clear }),
    [selected, selectionMode, toggle, clear]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// 고르기가 켜지지 않은 목록(워크스페이스 전체 목록)에서도 행은 그대로 그려져야 한다 — 그래서 컨텍스트가
// 없으면 "고를 수 없는 목록"으로 읽는다. 사이클은 팀의 것이라 일괄 이동이 있는 곳은 팀 스코프뿐이다.
export function useIssueSelection(): IssueSelectionValue | null {
  return useContext(Ctx)
}
