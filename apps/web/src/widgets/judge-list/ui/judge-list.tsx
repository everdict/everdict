'use client'

import { useMemo } from 'react'
import { Gavel } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { DeleteJudgeRowButton } from '@/features/delete-judge'
import {
  JUDGE_FACETS,
  JUDGE_GROUPINGS,
  JUDGE_ORDERS,
  judgeListSpec,
  SHARED_OWNER,
  type JudgeSummary,
} from '@/entities/judge'
import { fmtSubject } from '@/shared/lib/format'
import { applyListView } from '@/shared/lib/list-view'
import type { ListViewScope } from '@/shared/lib/load-list-view'
import { sortSemverDesc } from '@/shared/lib/semver'
import { useListView } from '@/shared/lib/use-list-view'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { facetOptionsOf, ListSection, ListToolbar, type FacetSpec } from '@/shared/ui/list-toolbar'

type Author = { name: string; avatarUrl?: string }

// 저지 목록의 행들과 그 위의 툴바. 하네스·데이터셋 목록과 같은 문법이고, 같은 이유로 클라이언트에 있다 —
// 컬렉션 전체가 손에 있으니 거르고 묶는 데 서버에 다녀올 이유가 없다.
export function JudgeList({
  workspace,
  judges,
  currentWorkspace,
  authors,
  scope,
  canDelete,
}: {
  workspace: string
  judges: JudgeSummary[]
  // 「출처」축의 이름표를 고르는 기준 — 이 워크스페이스가 만든 것인가, 기본 제공인가.
  currentWorkspace: string
  authors: Record<string, Author>
  scope: ListViewScope
  canDelete: boolean
}) {
  const t = useTranslations('judgesPage')
  const list = useTranslations('listView')

  const view = useListView({
    basePath: scope.basePath,
    viewKey: scope.viewKey,
    facets: JUDGE_FACETS,
    initialFilters: scope.filters,
    initialSearch: scope.search,
    initialDisplay: scope.display,
  })

  const creatorName = (subject: string): string => authors[subject]?.name ?? fmtSubject(subject)
  const ownerName = (owner: string): string =>
    owner === SHARED_OWNER || owner !== currentWorkspace
      ? list('ownerShared')
      : list('ownerWorkspace')

  const facets = useMemo((): FacetSpec[] => {
    const of = (facet: string, labelOf: (value: string) => string, unset?: string) => ({
      key: facet,
      label: list(`facet.${facet}`),
      options: facetOptionsOf(judges, (j) => judgeListSpec.facetValues(j, facet), labelOf, unset),
    })
    // 축이 제시할 값이 하나도 없으면 세우지 않는다. 「출처」는 값이 **하나뿐**일 때도 세우지 않는다 —
    // 전부 워크스페이스 것(또는 전부 기본 제공)인 목록에서 그 축은 아무것도 걸러 주지 못한다.
    const minimum = (facet: string): number => (facet === 'owner' ? 2 : 1)
    return [
      of('owner', ownerName),
      of('creator', creatorName, list('unset.creator')),
    ].filter((facet) => facet.options.length >= minimum(facet.key))
  }, [judges, list, authors, currentWorkspace])

  const { total, groups } = useMemo(
    () =>
      applyListView(
        judges,
        { filters: view.filters, search: view.search, display: view.display },
        judgeListSpec
      ),
    [judges, view.filters, view.search, view.display]
  )

  function groupLabel(key: string | null): string {
    if (key === null) return list(`unset.${view.display.grouping}`)
    if (view.display.grouping === 'creator') return creatorName(key)
    if (view.display.grouping === 'owner') return ownerName(key)
    return key
  }

  return (
    <div className="space-y-5">
      <ListToolbar
        search={view.search}
        onSearch={view.setSearch}
        facets={facets}
        filters={view.filters}
        onToggleFilter={view.toggleFilter}
        onClearFilters={view.clearFilters}
        total={total}
        groupings={JUDGE_GROUPINGS}
        orders={JUDGE_ORDERS}
        display={view.display}
        onDisplay={view.setDisplay}
      />

      {total === 0 ? (
        <EmptyState
          icon={<Gavel strokeWidth={1.75} />}
          title={list('emptyFilteredTitle')}
          hint={list('emptyFilteredHint')}
        />
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <ListSection
              key={group.key ?? 'unset'}
              grouped={view.display.grouping !== 'none'}
              label={groupLabel(group.key)}
              count={group.items.length}
            >
              {group.items.map((j) => (
                <Link
                  key={j.id}
                  href={`/${workspace}/judge/${encodeURIComponent(j.id)}`}
                  className="group flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border">
                      <Gavel className="size-[18px]" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 space-y-1">
                      <div className="truncate font-mono text-[13px] font-[560] text-foreground">
                        {j.id}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {j.versions.map((v) => (
                          <code
                            key={v}
                            className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border"
                          >
                            {v}
                          </code>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={j.owner === currentWorkspace ? 'success' : 'neutral'}>
                      {j.owner === currentWorkspace ? t('workspaceBadge') : t('sharedBadge')}
                    </Badge>
                    {canDelete && j.owner === currentWorkspace && (
                      <DeleteJudgeRowButton
                        id={j.id}
                        versions={[...sortSemverDesc(j.versions)].reverse()}
                        latest={sortSemverDesc(j.versions)[0] ?? j.versions[0] ?? ''}
                        workspace={workspace}
                        versionTags={j.versionTags ?? {}}
                      />
                    )}
                  </div>
                </Link>
              ))}
            </ListSection>
          ))}
        </div>
      )}
    </div>
  )
}
