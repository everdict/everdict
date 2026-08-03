'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Check, ListFilter, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  ISSUE_FILTER_FACETS,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  IssuePriorityIcon,
  IssueStatusIcon,
  issueFilterCount,
  issueViewHref,
  toggleIssueFilter,
  type IssueFilterFacet,
  type IssueView,
} from '@/entities/issue'
import { LabelDot } from '@/entities/issue-label'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { DropdownLabel, DropdownMenu, useDropdownClose } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'

import type { IssueDirectories } from '../model/directories'

// 미지정 버킷의 값. 쿼리 파라미터에는 null 이 없어서 빈 문자열이 그 이름이다 — 담당자·프로젝트·사이클
// 없음은 실제로 사람들이 거르는 그룹이라 필터로 닿을 수 있어야 한다.
const UNSET = ''

interface FacetOption {
  value: string
  label: string
  icon?: ReactNode
}

// 「필터」 — 리니어의 두 단계 메뉴(축 고르기 → 값 고르기). 적용된 필터는 메뉴 안이 아니라 툴바에 토큰으로
// 서고, 토큰마다 자기 제거 버튼을 갖는다: 걸어 둔 것을 보려고 메뉴를 다시 열어야 한다면 그건 숨긴 것이다.
export function IssueFilterMenu({
  basePath,
  view,
  directories,
  projects,
  cycles,
}: {
  basePath: string
  view: IssueView
  directories: IssueDirectories
  projects: { id: string; name: string }[]
  cycles: { id: string; name: string }[]
}) {
  const t = useTranslations('issuesPage')
  const active = issueFilterCount(view.filters)

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DropdownMenu
        contentClassName="w-64 p-1"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground"
          >
            <ListFilter className="size-3.5" strokeWidth={1.75} aria-hidden />
            {t('filter')}
            {active > 0 && (
              <span className="rounded-full bg-primary/15 px-1.5 text-[11px] tabular-nums text-foreground">
                {active}
              </span>
            )}
          </button>
        )}
      >
        <FilterPanel basePath={basePath} view={view} directories={directories} projects={projects} cycles={cycles} />
      </DropdownMenu>

      <FilterTokens
        basePath={basePath}
        view={view}
        directories={directories}
        projects={projects}
        cycles={cycles}
      />
    </div>
  )
}

// 축의 값 목록. 닫힌 어휘(상태·우선순위)는 카탈로그에서, 열린 것(사람·라벨·프로젝트·사이클)은 디렉터리에서.
function useFacetOptions(
  directories: IssueDirectories,
  projects: { id: string; name: string }[],
  cycles: { id: string; name: string }[]
): (facet: IssueFilterFacet) => FacetOption[] {
  const t = useTranslations('issuesPage')
  const tracker = useTranslations('tracker')
  return useMemo(
    () => (facet: IssueFilterFacet) => {
      switch (facet) {
        case 'status':
          return ISSUE_STATUSES.map((status) => ({
            value: status,
            label: tracker(`issueStatus.${status}`),
            icon: <IssueStatusIcon status={status} className="[&_svg]:size-3.5" />,
          }))
        case 'priority':
          return ISSUE_PRIORITIES.map((priority) => ({
            value: priority,
            label: tracker(`issuePriority.${priority}`),
            icon: <IssuePriorityIcon priority={priority} className="[&_svg]:size-3.5" />,
          }))
        case 'assignee':
          return [
            ...directories.members.map((member) => ({
              value: member.subject,
              label: member.name,
              icon: (
                <Avatar
                  name={member.name}
                  size="sm"
                  {...(member.avatarUrl !== undefined ? { url: member.avatarUrl } : {})}
                />
              ),
            })),
            { value: UNSET, label: t('groupUnset.assignee') },
          ]
        case 'label':
          return Object.values(directories.labels).map((label) => ({
            value: label.id,
            label: label.name,
            icon: <LabelDot color={label.color} />,
          }))
        case 'project':
          return [
            ...projects.map((project) => ({ value: project.id, label: project.name })),
            { value: UNSET, label: t('groupUnset.project') },
          ]
        case 'cycle':
          return [
            ...cycles.map((cycle) => ({ value: cycle.id, label: cycle.name })),
            { value: UNSET, label: t('groupUnset.cycle') },
          ]
      }
    },
    [directories, projects, cycles, t, tracker]
  )
}

function FilterPanel({
  basePath,
  view,
  directories,
  projects,
  cycles,
}: {
  basePath: string
  view: IssueView
  directories: IssueDirectories
  projects: { id: string; name: string }[]
  cycles: { id: string; name: string }[]
}) {
  const t = useTranslations('issuesPage')
  const router = useRouter()
  const close = useDropdownClose()
  const optionsOf = useFacetOptions(directories, projects, cycles)
  // 두 단계 메뉴의 현재 자리. 값을 고른 뒤에도 이 자리에 남는다 — 라벨 세 개를 걸려고 메뉴를 세 번 여는
  // 것은 필터 메뉴가 아니라 필터 대화상자다.
  const [facet, setFacet] = useState<IssueFilterFacet | null>(null)
  const [query, setQuery] = useState('')

  function toggle(target: IssueFilterFacet, value: string) {
    router.push(
      issueViewHref(basePath, { ...view, filters: toggleIssueFilter(view.filters, target, value) })
    )
  }

  if (facet === null)
    return (
      <>
        <DropdownLabel>{t('filterBy')}</DropdownLabel>
        {ISSUE_FILTER_FACETS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setFacet(option)
              setQuery('')
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-accent"
          >
            <span className="flex-1 truncate">{t(`facet.${option}`)}</span>
            {(view.filters[option]?.length ?? 0) > 0 && (
              <span className="rounded-full bg-secondary px-1.5 text-[11px] tabular-nums text-muted-foreground">
                {view.filters[option]?.length}
              </span>
            )}
          </button>
        ))}
      </>
    )

  const needle = query.trim().toLocaleLowerCase()
  const options = optionsOf(facet).filter(
    (option) => needle === '' || option.label.toLocaleLowerCase().includes(needle)
  )
  const selected = view.filters[facet] ?? []

  return (
    <>
      <div className="flex items-center gap-1 px-1 pb-1">
        <button
          type="button"
          onClick={() => setFacet(null)}
          aria-label={t('filterBack')}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        </button>
        <span className="flex-1 truncate text-[11px] font-[510] uppercase tracking-wide text-faint">
          {t(`facet.${facet}`)}
        </span>
      </div>
      <div className="px-1 pb-1">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('filterSearchPlaceholder')}
          autoFocus
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {options.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">{t('filterNoMatch')}</p>
        ) : (
          options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => toggle(facet, option.value)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-accent"
            >
              {option.icon}
              <span className="flex-1 truncate">{option.label}</span>
              {selected.includes(option.value) && <Check className="size-3.5 text-muted-foreground" />}
            </button>
          ))
        )}
      </div>
      <button
        type="button"
        onClick={close}
        className="mt-1 w-full rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {t('filterDone')}
      </button>
    </>
  )
}

// 지금 걸려 있는 것들 — 하나씩 뗄 수 있는 토큰. 메뉴 밖에 서는 이유는 위 주석과 같다.
function FilterTokens({
  basePath,
  view,
  directories,
  projects,
  cycles,
}: {
  basePath: string
  view: IssueView
  directories: IssueDirectories
  projects: { id: string; name: string }[]
  cycles: { id: string; name: string }[]
}) {
  const t = useTranslations('issuesPage')
  const router = useRouter()
  const optionsOf = useFacetOptions(directories, projects, cycles)
  if (issueFilterCount(view.filters) === 0) return null

  return (
    <>
      {ISSUE_FILTER_FACETS.flatMap((facet) => {
        const values = view.filters[facet] ?? []
        if (values.length === 0) return []
        const options = optionsOf(facet)
        return values.map((value) => {
          const label = options.find((option) => option.value === value)?.label ?? value
          return (
            <span
              key={`${facet}:${value}`}
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-0.5 pl-2 pr-1 text-[11.5px] text-foreground"
            >
              <span className="text-muted-foreground">{t(`facet.${facet}`)}</span>
              <span className="truncate">{label}</span>
              <button
                type="button"
                onClick={() =>
                  router.push(
                    issueViewHref(basePath, {
                      ...view,
                      filters: toggleIssueFilter(view.filters, facet, value),
                    })
                  )
                }
                aria-label={t('filterRemove', { name: label })}
                className="rounded-full p-0.5 transition-colors hover:bg-accent"
              >
                <X className="size-3" />
              </button>
            </span>
          )
        })
      })}
      <button
        type="button"
        onClick={() => router.push(issueViewHref(basePath, { ...view, filters: {} }))}
        className={cn('rounded-md px-1.5 py-0.5 text-[11.5px] text-muted-foreground', 'hover:bg-accent hover:text-foreground')}
      >
        {t('filterClear')}
      </button>
    </>
  )
}
