'use client'

import { useState } from 'react'
import { Check, ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  ISSUE_LINK_REF_KIND,
  issueLinkHref,
  type IssueCapabilityLinkType,
  type IssueLink,
} from '@/entities/issue'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { EntityRef } from '@/shared/ui/chip'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'

import { addIssueLinkAction, removeIssueLinkAction } from '../api/links'

// 고를 것이 이만큼 넘어가면 검색 줄을 낸다 — 프로젝트 피커와 같은 문턱값(스크롤로만 찾게 두지 않는다).
const SEARCH_FROM = 7

// 고를 수 있는 능력 하나 — 워크스페이스 레지스트리가 실제로 갖고 있는 것들이다.
export interface CapabilityOption {
  id: string
  // 이름만으로 구별되지 않을 때 옆에 붙는 한 줄(하네스는 모델·명령 요약, 데이터셋은 설명).
  hint?: string
}

interface CapabilityRef {
  id: string
  // 예전에(또는 에이전트가 MCP 로) 버전까지 박아 둔 링크는 그대로 보여 준다. 새로 거는 링크는 버전을 달지
  // 않는다 — 이슈가 뜻하는 것은 "이 저지"이지 "1.2.0 의 저지"가 아니고, 회귀 감시도 id 로 맞춘다
  // (docs/tracker.md). 화면이 버전을 물어보면 링크가 버전에 묶인 것처럼 읽힌다.
  version?: string
}

const refsOf = (links: IssueLink[]): CapabilityRef[] =>
  links.map((link) => ({
    id: link.id,
    ...(link.version !== undefined ? { version: link.version } : {}),
  }))

const keyOf = (links: IssueLink[]): string =>
  links.map((link) => `${link.id}@${link.version ?? ''}`).join(' ')

// 이 이슈를 검증하는 능력 한 종류(하네스·데이터셋·저지) — 상태·프로젝트·라벨과 같은 자리(속성 열)에서 바로
// 붙였다 뗀다. 예전에는 종류 콤보 + id 자유 입력 + 버전 자유 입력의 작은 폼이었는데, 그건 레지스트리에 무엇이
// 있는지 외우고 있는 사람만 쓸 수 있는 폼이었다 — 오타 하나면 아무 데도 가리키지 않는 링크가 생겼다(링크는
// 포인터라 제어 평면이 검증하지 않는다). 그래서 고르는 것은 워크스페이스에 등록된 것들뿐이다.
//
// 붙이기·떼기는 즉시 저장한다(폼이 아니라 컨트롤이다). 저장을 기다리는 동안에도 칩은 바뀐 대로 보이고,
// 거절당하면 되돌린 뒤 제어 평면의 사유를 그대로 보여 준다.
export function IssueCapabilityControl({
  workspace,
  issueId,
  type,
  links,
  options,
  canWrite,
}: {
  workspace: string
  issueId: string
  type: IssueCapabilityLinkType
  // 이 종류로 이미 걸려 있는 링크들.
  links: IssueLink[]
  // 이 워크스페이스에 등록된 같은 종류의 능력들 — 골라 붙일 수 있는 전부.
  options: CapabilityOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issueLinks')
  const tracker = useTranslations('tracker')
  const refresh = useRefresh()
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [selected, setSelected] = useState<CapabilityRef[]>(() => refsOf(links))
  const [seen, setSeen] = useState(() => keyOf(links))

  // 서버가 실어 온 값이 진실이다 — 저장이 끝나 페이지가 새로 그려졌거나 다른 화면이 고쳤으면 거기에 맞춘다.
  // 저장 중에는 맞추지 않는다: 연달아 두 번 토글하면 첫 응답이 두 번째 선택을 되돌려 깜빡인다.
  const fromServer = keyOf(links)
  if (!pending && fromServer !== seen) {
    setSeen(fromServer)
    setSelected(refsOf(links))
  }

  const kind = tracker(`linkType.${type}`)

  function toggle(id: string): void {
    const linked = selected.some((ref) => ref.id === id)
    const previous = selected
    setSelected(linked ? selected.filter((ref) => ref.id !== id) : [...selected, { id }])
    void (async () => {
      setPending(true)
      try {
        const r = linked
          ? await removeIssueLinkAction(issueId, type, id)
          : await addIssueLinkAction(issueId, { type, id })
        if (!r.ok) {
          setSelected(previous)
          toast.error(r.error ?? t(linked ? 'removeError' : 'addError'))
          return
        }
        // 나머지 화면(이력·평가 이력)은 뒤따라 온다. 이 줄은 그걸 기다리지 않는다.
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const chips = selected.map((ref) => (
    <span
      key={ref.id}
      className="inline-flex max-w-full items-center gap-1 rounded bg-secondary py-0.5 pl-1.5 pr-1 text-[11px] text-secondary-foreground ring-1 ring-inset ring-border"
    >
      <Link
        href={issueLinkHref(workspace, type, ref.id)}
        title={ref.id}
        className="min-w-0 transition-colors hover:text-foreground"
      >
        <EntityRef
          id={ref.id}
          {...(ref.version !== undefined ? { version: ref.version } : {})}
          kind={ISSUE_LINK_REF_KIND[type]}
        />
      </Link>
      {canWrite && (
        <button
          type="button"
          onClick={() => toggle(ref.id)}
          disabled={pending}
          aria-label={t('remove', { id: ref.id })}
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

  const needle = query.trim().toLocaleLowerCase()
  const choices = options.filter(
    (option) => needle === '' || option.id.toLocaleLowerCase().includes(needle)
  )
  const searchable = options.length > SEARCH_FROM

  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips}
      <DropdownMenu
        align="end"
        contentClassName={cn('p-1', searchable && 'w-64')}
        trigger={({ toggle: openMenu, open: menuOpen }) => (
          <button
            type="button"
            onClick={openMenu}
            aria-expanded={menuOpen}
            aria-label={t('controlLabel', { kind })}
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
        {searchable && (
          <div className="p-1">
            <Input
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              // 이 컨트롤이 폼 안에 놓이는 날을 대비한다 — Enter 가 폼을 제출해 버리면 고르다 말고 저장된다.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
            />
          </div>
        )}
        <div className="max-h-56 overflow-y-auto">
          {choices.map((option) => {
            const linked = selected.some((ref) => ref.id === option.id)
            return (
              <DropdownItem
                key={option.id}
                {...(linked ? { trailing: <Check className="size-3.5" /> } : {})}
                onSelect={() => toggle(option.id)}
              >
                <span className="font-mono text-[12px]">{option.id}</span>
                {option.hint !== undefined && (
                  <span className="text-[11px] text-faint"> · {option.hint}</span>
                )}
              </DropdownItem>
            )
          })}
          {choices.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-faint">
              {options.length === 0 ? t('none') : t('noMatch')}
            </p>
          )}
        </div>
      </DropdownMenu>
    </div>
  )
}
