'use client'

import { useMemo, useState } from 'react'
import { Boxes, Clock, Layers, Lock, Shapes, Trash2, Waypoints } from 'lucide-react'
import { useTimeZone, useTranslations } from 'next-intl'

import { DeleteHarnessDialog } from '@/features/delete-harness'
import {
  HARNESS_FACETS,
  HARNESS_GROUPINGS,
  HARNESS_ORDERS,
  harnessListSpec,
  harnessTags,
  type Harness,
} from '@/entities/harness'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import type { HarnessRelation } from '@/shared/lib/harness-relations'
import { applyListView } from '@/shared/lib/list-view'
import type { ListViewScope } from '@/shared/lib/load-list-view'
import { useListView } from '@/shared/lib/use-list-view'
import { cn } from '@/shared/lib/utils'
import { UserAvatar } from '@/shared/ui/avatar'
import { VersionTagChip } from '@/shared/ui/chip'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { facetOptionsOf, ListSection, ListToolbar, type FacetSpec } from '@/shared/ui/list-toolbar'
import { Score } from '@/shared/ui/score'
import { StatCard } from '@/shared/ui/stat-card'

type Author = { name: string; avatarUrl?: string }
type TeamOption = { id: string; key: string; name: string }

const STATUS_KEY: Record<string, string> = {
  succeeded: 'statusSucceeded',
  failed: 'statusFailed',
  running: 'statusRunning',
  queued: 'statusQueued',
}

// Latest run result — score if succeeded, otherwise the status label. Dash if there's no run history.
function LatestResult({ rel }: { rel?: HarnessRelation }) {
  const t = useTranslations('harnessList')
  if (!rel || !rel.lastStatus) return <span className="text-faint">{t('noRun')}</span>
  if (rel.lastStatus === 'succeeded') {
    return <Score passRate={rel.lastPassRate} mean={rel.lastMean} />
  }
  const key = STATUS_KEY[rel.lastStatus]
  return (
    <span
      className={cn(rel.lastStatus === 'failed' ? 'text-destructive' : 'text-muted-foreground')}
    >
      {key ? t(key) : rel.lastStatus}
    </span>
  )
}

// 한 형상 위의 하네스들을 구분하는 것은 이름이 아니라 **무엇을 바꿨는가**다. 제어 평면이 인스턴스 델타에서
// 뽑아 주므로(손으로 쓴 설명과 달리 낡지 않는다) 여기서는 그리기만 한다. 넘치는 것은 "+N".
const VARIATION_LIMIT = 3

function VariationChips({ variation }: { variation?: { scope?: string; label: string }[] }) {
  if (!variation || variation.length === 0) return null
  const shown = variation.slice(0, VARIATION_LIMIT)
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((c, i) => (
        <span
          key={`${c.scope ?? ''}${c.label}${i}`}
          className="inline-flex max-w-full items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--color-accent-foreground)] ring-1 ring-inset ring-primary/20"
        >
          {c.scope && <span className="text-muted-foreground">{c.scope}</span>}
          <span className="truncate">{c.label}</span>
        </span>
      ))}
      {variation.length > shown.length && (
        <span className="text-[10.5px] text-faint">+{variation.length - shown.length}</span>
      )}
    </div>
  )
}

// 사람이 단 라벨(버전 태그)이 목록에서 그 하네스의 이름표가 된다 — 어느 버전에 붙었는지는 hover 로.
// 델타 칩(무엇을 바꿨는가)과 달리 이것은 사람이 부르는 이름이라, 목록에서 "각각이 무엇인지"를 답한다.
const TAG_LIMIT = 4

function HarnessTagChips({ harness }: { harness: Harness }) {
  const tags = harnessTags(harness)
  if (tags.length === 0) return null
  const byVersion = harness.versionTags ?? {}
  const versionsOf = (tag: string) =>
    harness.versions.filter((v) => (byVersion[v] ?? []).includes(tag))
  const shown = tags.slice(0, TAG_LIMIT)
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((tag) => (
        <span
          key={tag}
          title={versionsOf(tag)
            .map((v) => `v${v}`)
            .join(', ')}
        >
          <VersionTagChip>{tag}</VersionTagChip>
        </span>
      ))}
      {tags.length > shown.length && (
        <span className="text-[10.5px] text-faint">+{tags.length - shown.length}</span>
      )}
    </div>
  )
}

export function HarnessList({
  workspace,
  harnesses,
  relations,
  authors,
  scope,
  canDelete = false,
}: {
  workspace: string
  harnesses: Harness[]
  relations: Record<string, HarnessRelation>
  authors: Record<string, Author>
  // 팀 축의 이름표 — id 를 사람이 부르는 이름으로 바꾸는 데만 쓴다.
  scope: ListViewScope
  // Admin — reveal a per-row delete (removes the whole harness); all listed harnesses are workspace-owned (delete-eligible).
  canDelete?: boolean
}) {
  const t = useTranslations('harnessList')
  const list = useTranslations('listView')
  const dt = useTranslations('deleteHarness')
  const timeZone = useTimeZone()
  // The harness currently pending deletion (opens the shared delete dialog).
  const [deleting, setDeleting] = useState<Harness | null>(null)

  const view = useListView({
    basePath: scope.basePath,
    viewKey: scope.viewKey,
    facets: HARNESS_FACETS,
    initialFilters: scope.filters,
    initialSearch: scope.search,
    initialDisplay: scope.display,
  })

  const catCount = useMemo(
    () => new Set(harnesses.map((h) => h.category).filter(Boolean)).size,
    [harnesses]
  )
  const ranCount = harnesses.filter((h) => relations[h.id]?.lastStatus).length

  function authorInfo(h: Harness): { name: string; avatarUrl?: string; known: boolean } {
    if (h.createdBy) {
      const a = authors[h.createdBy]
      return {
        name: a?.name ?? fmtSubject(h.createdBy),
        ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
        known: true,
      }
    }
    return { name: '—', known: false }
  }

  const creatorName = (subject: string): string => authors[subject]?.name ?? fmtSubject(subject)

  // 축의 값은 **이 컬렉션에 있는 것만** 제시한다 — 고르면 언제나 빈 목록인 선택지를 내밀지 않기 위해서다.
  const facets = useMemo((): FacetSpec[] => {
    const of = (facet: string, labelOf: (value: string) => string, unset?: string) => ({
      key: facet,
      label: list(`facet.${facet}`),
      options: facetOptionsOf(
        harnesses,
        (h) => harnessListSpec.facetValues(h, facet),
        labelOf,
        unset
      ),
    })
    return [
      of('category', (value) => value, list('unset.category')),
      of('kind', (value) => value, list('unset.kind')),
      of('creator', creatorName, list('unset.creator')),
      of('tag', (value) => value, list('unset.tag')),
      // 팀이 하나도 없는 워크스페이스에 팀 축을 세워 봐야 고를 것이 없다.
    ].filter((facet) => facet.options.length > 0)
  }, [harnesses, list, authors])

  const { total, groups } = useMemo(
    () =>
      applyListView(
        harnesses,
        { filters: view.filters, search: view.search, display: view.display },
        harnessListSpec
      ),
    [harnesses, view.filters, view.search, view.display]
  )

  // 그룹 하나의 이름표. 축마다 어휘가 달라서(형상은 식별자, 팀·사람은 이름) 한 곳에서 푼다.
  function groupLabel(key: string | null) {
    if (key === null) return list(`unset.${view.display.grouping}`)
    if (view.display.grouping === 'template')
      return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Shapes className="size-3.5 shrink-0 text-faint" strokeWidth={1.75} aria-hidden />
          <span className="truncate font-mono text-[11.5px]">{key}</span>
        </span>
      )
    if (view.display.grouping === 'creator') return creatorName(key)
    return key
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label={t('statHarnesses')} value={harnesses.length} />
        <StatCard label={t('statCategories')} value={catCount} />
        <StatCard
          label={t('statRan')}
          value={ranCount}
          tone={ranCount > 0 ? 'primary' : 'default'}
        />
      </div>

      <ListToolbar
        search={view.search}
        onSearch={view.setSearch}
        facets={facets}
        filters={view.filters}
        onToggleFilter={view.toggleFilter}
        onClearFilters={view.clearFilters}
        total={total}
        groupings={HARNESS_GROUPINGS}
        orders={HARNESS_ORDERS}
        display={view.display}
        onDisplay={view.setDisplay}
      />

      {total === 0 ? (
        <EmptyState
          icon={<Boxes />}
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
              {group.items.map((h) => {
                const latest = h.latestVersion ?? h.versions[h.versions.length - 1]
                const nver = h.versionCount ?? h.versions.length
                const rel = relations[h.id]
                const author = authorInfo(h)
                return (
                  <Link
                    key={h.id}
                    href={`/${workspace}/harness/${encodeURIComponent(h.id)}`}
                    className="group block rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border group-hover:text-foreground">
                          <Boxes className="size-[18px]" strokeWidth={1.75} />
                        </span>
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[13px] font-[560] text-foreground">
                              {h.id}
                            </span>
                            {latest && (
                              <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                                v{latest}
                              </code>
                            )}
                            {nver > 1 && (
                              <span className="text-[11px] text-faint">
                                {t('moreVersions', { n: nver - 1 })}
                              </span>
                            )}
                            {h.private && (
                              <span
                                title={t('privateTitle')}
                                className="inline-flex items-center gap-0.5 rounded bg-[var(--color-warning)]/10 px-1.5 py-0.5 text-[10.5px] font-[510] text-[var(--color-warning)] ring-1 ring-inset ring-[var(--color-warning)]/30"
                              >
                                <Lock className="size-2.5" /> {t('privateBadge')}
                              </span>
                            )}
                          </div>
                          {h.subtitle && (
                            <p className="line-clamp-1 font-mono text-[12px] text-muted-foreground">
                              {h.subtitle}
                            </p>
                          )}
                          <VariationChips variation={h.variation} />
                          <HarnessTagChips harness={h} />
                          <div className="flex flex-wrap items-center gap-1">
                            {h.category && (
                              <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                                {h.category}
                              </span>
                            )}
                            {h.kind && (
                              <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground">
                                {h.kind}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {canDelete && (
                          <button
                            type="button"
                            aria-label={dt('rowDeleteAria', { id: h.id })}
                            title={dt('rowDeleteTitle')}
                            onClick={(e) => {
                              // The whole card is a Link — stop it so the trash click doesn't navigate.
                              e.preventDefault()
                              e.stopPropagation()
                              setDeleting(h)
                            }}
                            className="grid size-7 place-items-center rounded-md text-faint opacity-0 outline-none transition-[opacity,color,background] hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        )}
                        {author.known && (
                          <UserAvatar
                            name={author.name}
                            url={author.avatarUrl}
                            label={t('creator')}
                          />
                        )}
                      </div>
                    </div>

                    {/* Meta line — versions · benchmarks run · latest result (+time) */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-11 text-[11.5px] text-faint">
                      <span className="inline-flex items-center gap-1">
                        <Layers className="size-3.5" />
                        {t('versions')}{' '}
                        <span className="tabular-nums text-muted-foreground">{nver}</span>
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Waypoints className="size-3.5" />
                        {rel && rel.datasets.length > 0 ? (
                          <span className="inline-flex flex-wrap items-center gap-1">
                            {rel.datasets.slice(0, 3).map((d) => (
                              <code
                                key={d}
                                className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground"
                              >
                                {d}
                              </code>
                            ))}
                            {rel.datasets.length > 3 && (
                              <span className="text-faint">+{rel.datasets.length - 3}</span>
                            )}
                          </span>
                        ) : (
                          <span>{t('noBenchmark')}</span>
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="text-faint">{t('latestResult')}</span>
                        <LatestResult rel={rel} />
                      </span>
                      {rel?.lastRunAt && (
                        <span
                          className="inline-flex items-center gap-1"
                          title={t('lastRunAt', {
                            at: fmtDateTimeFull(rel.lastRunAt, { timeZone }),
                          })}
                        >
                          <Clock className="size-3.5" />
                          {fmtDateTime(rel.lastRunAt, timeZone)}
                        </span>
                      )}
                    </div>
                  </Link>
                )
              })}
            </ListSection>
          ))}
        </div>
      )}

      {deleting && (
        <DeleteHarnessDialog
          onClose={() => setDeleting(null)}
          id={deleting.id}
          versions={deleting.versions}
          latest={deleting.latestVersion ?? deleting.versions[deleting.versions.length - 1] ?? ''}
          workspace={workspace}
          {...(deleting.versionTags ? { versionTags: deleting.versionTags } : {})}
          defaultAllSelected
        />
      )}
    </div>
  )
}
