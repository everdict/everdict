'use client'

import { useState } from 'react'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Check, ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { issueHref, IssueStatusIcon, type IssueStatus } from '@/entities/issue'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'

import { updateIssueAction } from '../api/issues'

export interface IssueParentOption {
  id: string
  identifier: string
  title: string
  // 상태까지 들고 온다 — 이미 끝난 이슈 아래로 일을 넣는 것과 진행 중인 것 아래로 넣는 것은 다른 결정이다.
  status: IssueStatus
}

// 고를 것이 이만큼 넘어가면 검색 줄을 낸다 — 프로젝트 선택기와 같은 문턱값.
const SEARCH_FROM = 7

// 이 이슈가 쪼개져 나온 상위 이슈 — 상태·프로젝트·사이클과 같은 자리(속성 열)에서 읽고 바꾼다.
//
// 예전에는 상위 이슈가 브레드크럼의 식별자 한 조각으로만 있었다. 그래서 하위 이슈를 열어도 "이게 무엇의
// 하위인가"는 그 짧은 `ENG-11` 하나로 짐작해야 했고, 붙이거나 떼는 길은 화면 어디에도 없었다(에이전트만
// 할 수 있었다). 속성 열은 이 이슈가 무엇에 속하는지를 모아 두는 자리이고, 상위 이슈는 그중에서도 가장
// 먼저 읽혀야 하는 소속이다.
export function IssueParentControl({
  workspace,
  id,
  parent,
  options,
  canWrite,
}: {
  workspace: string
  id: string
  parent: IssueParentOption | undefined
  // 상위로 세울 수 있는 이슈들 — 같은 팀의 이슈를 화면이 걸러 온다. 자기 자신과 자기 하위 이슈는 빠져 있다
  // (자기 자손을 부모로 세우면 고리가 닫힌다). 더 깊은 자손까지는 제어 평면이 판정하고, 거절은 그대로 뜬다.
  options: IssueParentOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issuesPage')
  const refresh = useRefresh()
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)

  // `null` 은 비운다 — 상위 이슈에서 뗀다는 뜻이고, `undefined`(손대지 않음)와 절대 섞이면 안 된다.
  function assign(parentId: string | null): void {
    if (parentId === (parent?.id ?? null)) return
    void (async () => {
      setPending(true)
      try {
        const r = await updateIssueAction(id, { parentId })
        if (!r.ok) {
          toast.error(r.error ?? t('parentError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const chip = parent ? (
    <Link
      href={issueHref(workspace, parent.identifier, parent.title)}
      title={`${parent.identifier} · ${parent.title}`}
      className="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
    >
      <IssueStatusIcon status={parent.status} className="shrink-0" />
      <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
        {parent.identifier}
      </span>
      <span className="truncate">{parent.title}</span>
    </Link>
  ) : null

  if (!canWrite) return chip

  const needle = query.trim().toLocaleLowerCase()
  const choices = options.filter(
    (option) =>
      option.id !== id &&
      (needle === '' ||
        option.title.toLocaleLowerCase().includes(needle) ||
        option.identifier.toLocaleLowerCase().includes(needle))
  )
  const searchable = options.length > SEARCH_FROM

  return (
    <div className="flex min-w-0 items-center gap-1">
      {chip}
      <DropdownMenu
        align="end"
        contentClassName={cn('p-1', searchable && 'w-72')}
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('parentControlLabel')}
            disabled={pending}
            className={cn(
              'shrink-0 transition-colors disabled:opacity-50',
              parent
                ? 'inline-flex size-5 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground'
                : // 아직 어디에도 속하지 않은 이슈에서는 이 버튼이 유일한 안내다 — 그때만 글자를 단다.
                  'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground hover:border-border-strong hover:bg-accent hover:text-foreground'
            )}
          >
            {pending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : parent ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <>
                <Plus className="size-3" />
                <span>{t('parentAdd')}</span>
              </>
            )}
          </button>
        )}
      >
        {searchable && (
          <div className="p-1">
            <Input
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('parentSearchPlaceholder')}
              // 이 컨트롤이 폼 안에 놓이는 날을 대비한다 — Enter 가 폼을 제출해 버리면 고르다 말고 저장된다.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
            />
          </div>
        )}
        <div className="max-h-56 overflow-y-auto">
          {choices.map((option) => (
            <DropdownItem
              key={option.id}
              icon={<IssueStatusIcon status={option.status} />}
              {...(option.id === parent?.id ? { trailing: <Check className="size-3.5" /> } : {})}
              onSelect={() => assign(option.id)}
            >
              <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">
                {option.identifier}
              </span>
              {option.title}
            </DropdownItem>
          ))}
          {choices.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-faint">{t('parentNoMatch')}</p>
          )}
        </div>
        {parent && (
          <>
            <DropdownSeparator />
            <DropdownItem icon={<X className="size-3.5" />} onSelect={() => assign(null)}>
              {t('parentClear')}
            </DropdownItem>
          </>
        )}
      </DropdownMenu>
    </div>
  )
}
