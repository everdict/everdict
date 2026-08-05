'use client'

import { useState } from 'react'
import { ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  issueHref,
  IssueSearchOptions,
  IssueStatusIcon,
  type IssueMentionLinkType,
  type IssueOption,
} from '@/entities/issue'
import { useRefresh } from '@/shared/lib/use-refresh'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Link } from '@/shared/ui/link'

import { addIssueLinkAction, removeIssueLinkAction } from '../api/links'

// 이 이슈가 **언급한** 다른 이슈들 — GitHub 이 `#123` 으로 적는 교차참조를, 여기서는 골라서 만든다
// (사용자 결정: 본문 텍스트 자동 파싱이 아니라 피커). 저장은 언급하는 쪽 레코드에 한 방향으로만 하고,
// 언급당한 이슈는 자기 화면에서 역방향 질의로 「언급한 이슈」 줄을 그린다 — 그래서 양쪽에서 보인다.
//
// 링크가 들고 있는 것은 UUID 라서 그 자체로는 사람에게 아무 말도 하지 않는다. 그리기 위한 식별자·제목·상태는
// 서버 컴포넌트가 이미 풀어서 넘겨 주고(`mentions`), 여기서 방금 고른 것은 피커가 준 행을 그대로 쓴다.
export function IssueMentionControl({
  workspace,
  issueId,
  type,
  mentions,
  canWrite,
}: {
  workspace: string
  issueId: string
  // 지금은 `issue` 하나 — 어휘가 늘면 같은 컨트롤이 그 종류를 받는다(`ISSUE_MENTION_LINK_TYPES`).
  type: IssueMentionLinkType
  // 이 이슈가 언급한 것들, 이미 풀린 상태로.
  mentions: IssueOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issueLinks')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)
  const [selected, setSelected] = useState<IssueOption[]>(mentions)
  const [seen, setSeen] = useState(() => mentions.map((m) => m.id).join(' '))

  // 서버가 실어 온 값이 진실이다 — 저장이 끝나 페이지가 새로 그려졌거나 다른 화면이 고쳤으면 거기에 맞춘다.
  // 저장 중에는 맞추지 않는다: 연달아 두 번 고르면 첫 응답이 두 번째 선택을 되돌려 깜빡인다.
  const fromServer = mentions.map((m) => m.id).join(' ')
  if (!pending && fromServer !== seen) {
    setSeen(fromServer)
    setSelected(mentions)
  }

  function mutate(next: IssueOption[], run: () => Promise<{ ok: boolean; error?: string }>): void {
    const previous = selected
    setSelected(next)
    void (async () => {
      setPending(true)
      try {
        const r = await run()
        if (!r.ok) {
          setSelected(previous)
          toast.error(r.error ?? t('addError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const add = (issue: IssueOption): void =>
    mutate([...selected, issue], () => addIssueLinkAction(issueId, { type, id: issue.id }))

  const remove = (issue: IssueOption): void =>
    mutate(
      selected.filter((x) => x.id !== issue.id),
      () => removeIssueLinkAction(issueId, type, issue.id)
    )

  const chips = selected.map((issue) => (
    <span
      key={issue.id}
      className="inline-flex max-w-full items-center gap-1 rounded bg-secondary py-0.5 pl-1.5 pr-1 text-[11px] text-secondary-foreground ring-1 ring-inset ring-border"
    >
      <Link
        href={issueHref(workspace, issue.identifier, issue.title)}
        title={`${issue.identifier} · ${issue.title}`}
        className="inline-flex min-w-0 items-center gap-1 transition-colors hover:text-foreground"
      >
        <IssueStatusIcon status={issue.status} />
        <span className="shrink-0 font-mono">{issue.identifier}</span>
        <span className="min-w-0 truncate">{issue.title}</span>
      </Link>
      {canWrite && (
        <button
          type="button"
          onClick={() => remove(issue)}
          disabled={pending}
          aria-label={t('remove', { id: issue.identifier })}
          className="rounded p-0.5 text-faint transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  ))

  if (!canWrite) {
    if (chips.length === 0) return null
    return <span className="inline-flex flex-wrap items-center gap-1">{chips}</span>
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips}
      <DropdownMenu
        align="end"
        contentClassName="w-72 p-2"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('mentionControlLabel')}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {pending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : chips.length === 0 ? (
              <Plus className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
            {/* 아직 아무것도 안 걸린 줄에서는 이 버튼이 유일한 안내다 — 그때만 글자를 단다. */}
            {chips.length === 0 && <span>{t('add')}</span>}
          </button>
        )}
      >
        {/* 자기 자신과 이미 언급한 것은 후보가 아니다 — 고를 수 있는 것은 실제로 새로 걸리는 것들뿐이다. */}
        <IssueSearchOptions
          autoFocus
          exclude={[issueId, ...selected.map((issue) => issue.id)]}
          onSelect={add}
        />
      </DropdownMenu>
    </div>
  )
}
