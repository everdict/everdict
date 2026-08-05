'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { z } from 'zod'

import { useDropdownClose } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'

import { issueStatusSchema, type IssueStatus } from '../model/schema'
import { IssueStatusIcon } from './issue-status-badge'

// 이슈를 이름으로 찾아 하나 고르는 목록 — 트리거는 호스트가 그린다(라벨 피커가 `IssueLabelOptions` 와
// `IssueLabelControl` 로 갈라지는 것과 같은 이유: 같은 목록을 이슈 상세의 속성 행도, 하네스 상세의
// 「이슈 연결」 버튼도 쓴다).
//
// 좁히는 일은 서버가 한다 — 타이핑마다 `/api/issues/search?q=` 를 다시 부른다. 창 하나를 받아 여기서
// 거르면 워크스페이스가 그 창보다 커지는 순간 조용히 못 찾기 시작한다.

// 타이핑이 멎기를 기다리는 시간(ms). 한 글자마다 한 번씩 서버를 부르지 않되, 사람이 "안 뜨네"라고 느끼기
// 전에는 결과가 와야 한다.
const DEBOUNCE_MS = 200

export interface IssueOption {
  id: string
  identifier: string
  title: string
  status: IssueStatus
}

const issueOptionsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string(),
      status: issueStatusSchema,
    })
  ),
})

export function IssueSearchOptions({
  exclude,
  onSelect,
  autoFocus,
}: {
  // 후보에서 뺄 이슈들 — 이미 언급한 것, 그리고 (이슈 상세에서는) 자기 자신.
  exclude?: string[]
  onSelect: (issue: IssueOption) => void
  autoFocus?: boolean
}) {
  const t = useTranslations('issueLinks')
  // 팝오버 안에서 열렸으면 고른 뒤 닫는다 — 하나를 고르는 목록이라 열어 둘 이유가 없다. 팝오버 밖에서
  // 쓰이면 아무 일도 하지 않는다(컨텍스트가 없을 때 no-op 인 훅).
  const close = useDropdownClose()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<IssueOption[]>([])
  const [loading, setLoading] = useState(true)

  const excluded = exclude?.join(' ') ?? ''
  useEffect(() => {
    // 취소는 두 겹이다: 아직 안 나간 요청은 타이머로, 이미 나간 요청은 AbortController 로 접는다.
    // 늦게 도착한 예전 검색어의 응답이 지금 화면을 덮어쓰면 목록이 타이핑을 거슬러 올라간다.
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const params = new URLSearchParams()
      if (query.trim()) params.set('q', query.trim())
      for (const id of excluded.split(' ').filter(Boolean)) params.append('exclude', id)
      setLoading(true)
      fetch(`/api/issues/search?${params.toString()}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((body) => setItems(issueOptionsSchema.parse(body).items))
        // 검색이 실패하면 고를 것이 없는 것과 같다 — 목록 자리에 오류를 쌓지 않는다(빈 목록 문구가 답한다).
        .catch(() => undefined)
        .finally(() => setLoading(false))
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, excluded])

  return (
    <div className="space-y-2">
      <Input
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('searchIssuePlaceholder')}
        // 이 컨트롤이 폼 안에 놓이는 날을 대비한다 — Enter 가 폼을 제출해 버리면 고르다 말고 저장된다.
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault()
        }}
      />
      <div className="max-h-56 space-y-0.5 overflow-y-auto">
        {items.map((issue) => (
          <button
            key={issue.id}
            type="button"
            onClick={() => {
              close()
              onSelect(issue)
            }}
            title={`${issue.identifier} · ${issue.title}`}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <IssueStatusIcon status={issue.status} />
            <span className="shrink-0 font-mono text-[11.5px]">{issue.identifier}</span>
            <span className="min-w-0 flex-1 truncate">{issue.title}</span>
          </button>
        ))}
        {items.length === 0 && (
          <p className="flex items-center gap-1.5 px-1.5 py-1 text-[12px] text-faint">
            {loading ? <Loader2 className="size-3 animate-spin" /> : null}
            {loading ? t('searching') : t('noIssueMatch')}
          </p>
        )}
      </div>
    </div>
  )
}
