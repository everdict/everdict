'use client'

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

import type { ScorecardCaseView } from '../model/case-view'
import { CaseDetailDialog } from './case-detail-dialog'

// 케이스 상세를 여는 문은 한 곳이 아니다 — 케이스 행, 진행 타임라인의 케이스 스텝. 흩어진 섹션들이 하나의
// 다이얼로그 상태를 공유하도록 컨텍스트로 묶는다. 열림 상태는 ?case= 로 URL 에 미러링되어(다이얼로그 공유
// 관례 — docs/web.md) 지금 주소가 곧 이 케이스의 공유 링크가 된다. replaceState(state=null 필수: Next 의
// __NA 마커가 실리면 라우터 주소 동기화가 끊겨 다음 서버 액션이 옛 주소를 되살린다), 라우트 재렌더 없음.
type ScorecardCasesContextValue = {
  cases: ScorecardCaseView[]
  // 행의 유일 key 로 연다 — 트라이얼 배치에서 caseId 는 여러 행에 반복되므로 key 가 선택의 단위다.
  openCase: (key: string) => void
}

const ScorecardCasesContext = createContext<ScorecardCasesContextValue | null>(null)

export function useScorecardCases(): ScorecardCasesContextValue {
  const ctx = useContext(ScorecardCasesContext)
  if (!ctx) throw new Error('useScorecardCases must be used within ScorecardCasesProvider')
  return ctx
}

// 열림 상태를 URL 에 쓰거나 지운다 — 케이스 필터(?cases=failed)는 건드리지 않는다.
function mirrorCaseParam(key: string | undefined) {
  const url = new URL(window.location.href)
  if (key !== undefined) url.searchParams.set('case', key)
  else url.searchParams.delete('case')
  window.history.replaceState(null, '', url.pathname + url.search + url.hash)
}

export function ScorecardCasesProvider({
  workspace,
  scorecardId,
  cases,
  initialCaseId,
  children,
}: {
  workspace: string
  scorecardId: string
  cases: ScorecardCaseView[]
  // 딥링크(?case=)로 열려 들어온 케이스 — 페이지가 searchParams 를 읽어 넘긴다. 목록에 없으면 무시.
  initialCaseId: string | undefined
  children: ReactNode
}) {
  // 딥링크는 행 key 정확 일치를 먼저, 아니면 그 caseId 의 첫 행을 연다 (트라이얼 순번 없는 예전 링크 호환).
  const [activeKey, setActiveKey] = useState<string | undefined>(() => {
    if (initialCaseId === undefined) return undefined
    const exact = cases.find((c) => c.key === initialCaseId)
    return (exact ?? cases.find((c) => c.caseId === initialCaseId))?.key
  })

  const openCase = useCallback((key: string) => {
    setActiveKey(key)
    mirrorCaseParam(key)
  }, [])
  const close = useCallback(() => {
    setActiveKey(undefined)
    mirrorCaseParam(undefined)
  }, [])

  const index = cases.findIndex((c) => c.key === activeKey)
  const active = index >= 0 ? cases[index] : undefined

  return (
    <ScorecardCasesContext.Provider value={{ cases, openCase }}>
      {children}
      {active && (
        <CaseDetailDialog
          workspace={workspace}
          scorecardId={scorecardId}
          item={active}
          onClose={close}
          nav={{
            index,
            total: cases.length,
            onPrev: () => {
              const prev = cases[index - 1]
              if (prev) openCase(prev.key)
            },
            onNext: () => {
              const next = cases[index + 1]
              if (next) openCase(next.key)
            },
          }}
        />
      )}
    </ScorecardCasesContext.Provider>
  )
}

// 진행 타임라인의 케이스 스텝에 서는 작은 문 — "→ run" 링크와 같은 문법의 인라인 칩. 케이스 결과가 있는
// 스텝에만 서버가 세운다(결과 없는 스텝은 기존 → run 링크가 유일한 문으로 남는다).
export function OpenCaseChip({ caseId }: { caseId: string }) {
  const ctx = useContext(ScorecardCasesContext)
  // 타임라인 스텝은 caseId 만 안다 — 트라이얼 배치에서는 그 케이스의 첫 행을 연다(다이얼로그에서 형제 이동).
  const first = ctx?.cases.find((c) => c.caseId === caseId)
  if (!ctx || !first) return null
  return (
    <button
      type="button"
      onClick={() => ctx.openCase(first.key)}
      className="ml-2 rounded-sm font-mono text-[11px] text-link transition-colors hover:text-foreground"
    >
      → case
    </button>
  )
}
