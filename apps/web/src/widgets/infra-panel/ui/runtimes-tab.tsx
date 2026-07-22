'use client'

import { useEffect, useState } from 'react'
import { Laptop, Loader2, Server } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { z } from 'zod'

import { runsSchema, type Run } from '@/entities/run'
import { runnerMetaSchema, type RunnerMeta } from '@/entities/runner'
import {
  runtimeSpecSchema,
  runtimesSchema,
  runtimeSummarySchema,
  type RuntimeSpec,
  type RuntimeSummary,
} from '@/entities/runtime'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { EntityRef } from '@/shared/ui/chip'
import { StatusIcon } from '@/shared/ui/status-pill'

import { useInfraPanel } from '../model/infra-panel-context'
import { DetailNav, MetaRow, SectionLabel } from './panel-bits'

// Runtimes tab — the execution-infra roster with its OWN navigation: clicking a runtime or runner drills into
// an in-panel detail. The left half never navigates — the panel shows the full content itself (no "full page"
// escape hatch).

const POLL_MS = 10_000
// Online check — a runner refreshes lastSeenAt on every long-poll lease (~25s), so within 90s it counts as connected
// (same convention as the runners managers).
const ONLINE_WINDOW_MS = 90_000

const rosterSchema = z.object({
  runtimes: runtimesSchema,
  runners: z.array(runnerMetaSchema),
})

const runtimeDetailSchema = z.object({
  summary: runtimeSummarySchema,
  spec: runtimeSpecSchema.optional(),
})

function isOnline(lastSeenAt?: string): boolean {
  return lastSeenAt !== undefined && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS
}

export function RuntimesTab() {
  const t = useTranslations('infraPanel')
  const { runtimesDetail, setRuntimesDetail } = useInfraPanel()
  const [roster, setRoster] = useState<{
    runtimes: RuntimeSummary[]
    runners: RunnerMeta[]
  } | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch('/api/runtimes', { cache: 'no-store' })
        if (res.ok) {
          const parsed = rosterSchema.safeParse(await res.json())
          if (stopped) return
          if (parsed.success) setRoster(parsed.data)
        }
      } catch {
        // transient — keep polling
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (runtimesDetail?.kind === 'runtime')
    return <RuntimeDetail id={runtimesDetail.id} onBack={() => setRuntimesDetail(null)} />
  if (runtimesDetail?.kind === 'runner')
    return (
      <RunnerDetail
        id={runtimesDetail.id}
        meta={roster?.runners.find((r) => r.id === runtimesDetail.id)}
        loading={roster === null}
        onBack={() => setRuntimesDetail(null)}
      />
    )

  if (!roster)
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-faint">
        <Loader2 className="size-3.5 animate-spin" /> {t('loading')}
      </div>
    )

  if (roster.runtimes.length === 0 && roster.runners.length === 0)
    return <p className="py-8 text-center text-[12.5px] text-faint">{t('runtimesEmpty')}</p>

  return (
    <div className="space-y-4 px-3.5 py-3.5">
      {roster.runtimes.length > 0 && (
        <section className="space-y-1">
          <SectionLabel count={roster.runtimes.length}>{t('workspaceRuntimes')}</SectionLabel>
          <div className="space-y-1">
            {roster.runtimes.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRuntimesDetail({ kind: 'runtime', id: r.id })}
                className="flex w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <Server className="size-3.5 shrink-0 text-[#6ec6a8]" />
                <span className="min-w-0 flex-1 truncate text-[12px] font-[510]">{r.id}</span>
                {(r.capabilities ?? []).map((c) => (
                  <Badge key={c} tone="neutral" className="hidden shrink-0 sm:inline-flex">
                    {c}
                  </Badge>
                ))}
                <span className="shrink-0 font-mono text-[10.5px] text-faint">
                  {t('versionCount', { n: r.versions.length })}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {roster.runners.length > 0 && (
        <section className="space-y-1">
          <SectionLabel count={roster.runners.length}>{t('myRunners')}</SectionLabel>
          <div className="space-y-1">
            {roster.runners.map((r) => {
              const online = isOnline(r.lastSeenAt)
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRuntimesDetail({ kind: 'runner', id: r.id })}
                  className="flex w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-elevated"
                >
                  <Laptop className="size-3.5 shrink-0 text-[#6ec6a8]" />
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      online ? 'bg-[#6ec6a8]' : 'bg-muted-foreground/40'
                    )}
                  />
                  <span className="min-w-0 flex-1 space-y-0.5 overflow-hidden whitespace-nowrap">
                    <span className="block truncate text-[12px] font-[510]">{r.label}</span>
                    {r.status && (
                      <span
                        className={cn(
                          'block truncate text-[10.5px]',
                          r.status.level === 'error'
                            ? 'text-[var(--color-destructive)]'
                            : r.status.level === 'warn'
                              ? 'text-[var(--color-warning)]'
                              : 'text-faint'
                        )}
                      >
                        {r.status.text}
                      </span>
                    )}
                  </span>
                  {r.updateRequired && (
                    <Badge tone="info" className="shrink-0">
                      {t('updateRequired')}
                    </Badge>
                  )}
                  <Badge tone={online ? 'success' : 'neutral'} className="shrink-0">
                    {online ? t('online') : t('offline')}
                  </Badge>
                  {r.lastSeenAt && !online && (
                    <time
                      className="shrink-0 font-mono text-[10.5px] text-faint"
                      title={fmtDateTimeFull(r.lastSeenAt)}
                    >
                      {fmtDateTime(r.lastSeenAt)}
                    </time>
                  )}
                </button>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}

// Registered-runtime drill-in — the latest version's spec, read once per id (the roster poll keeps the list fresh;
// a spec is immutable per version so it doesn't need polling).
function RuntimeDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useTranslations('infraPanel')
  const [detail, setDetail] = useState<{ summary: RuntimeSummary; spec?: RuntimeSpec } | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    setDetail(null)
    setMissing(false)
    let stopped = false
    void (async () => {
      try {
        const res = await fetch(`/api/runtimes/${encodeURIComponent(id)}`, { cache: 'no-store' })
        if (stopped) return
        if (!res.ok) {
          setMissing(true)
          return
        }
        const parsed = runtimeDetailSchema.safeParse(await res.json())
        if (parsed.success) setDetail(parsed.data)
        else setMissing(true)
      } catch {
        if (!stopped) setMissing(true)
      }
    })()
    return () => {
      stopped = true
    }
  }, [id])

  const spec = detail?.spec
  return (
    <div className="space-y-3 px-3.5 py-3">
      <DetailNav onBack={onBack} />
      <div className="flex flex-wrap items-center gap-2">
        <Server className="size-4 shrink-0 text-[#6ec6a8]" />
        <span className="min-w-0 truncate text-[13px] font-[560]">{id}</span>
        {spec && <Badge tone="info">{spec.kind}</Badge>}
      </div>

      {missing && <p className="py-6 text-center text-[12.5px] text-faint">{t('detailMissing')}</p>}
      {!missing && !detail && (
        <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-faint">
          <Loader2 className="size-3.5 animate-spin" /> {t('loading')}
        </div>
      )}

      {detail && (
        <>
          {spec?.description && (
            <p className="text-[12px] text-muted-foreground">{spec.description}</p>
          )}
          <div className="rounded-md border bg-card px-2.5 py-1.5">
            {spec?.addr && <MetaRow label={t('addr')}>{spec.addr}</MetaRow>}
            {spec?.context && <MetaRow label={t('contextLabel')}>{spec.context}</MetaRow>}
            {spec?.server && <MetaRow label={t('serverLabel')}>{spec.server}</MetaRow>}
            {spec?.namespace && <MetaRow label={t('namespaceLabel')}>{spec.namespace}</MetaRow>}
            {spec?.image && <MetaRow label={t('imageLabel')}>{spec.image}</MetaRow>}
            {spec?.browserImage && (
              <MetaRow label={t('browserImageLabel')}>{spec.browserImage}</MetaRow>
            )}
            {spec?.runtimeClass && (
              <MetaRow label={t('runtimeClassLabel')}>{spec.runtimeClass}</MetaRow>
            )}
            {spec?.maxConcurrent !== undefined && (
              <MetaRow label={t('maxConcurrentLabel')}>{spec.maxConcurrent}</MetaRow>
            )}
            {spec?.memoryBudgetMb !== undefined && (
              <MetaRow label={t('memoryBudgetLabel')}>{spec.memoryBudgetMb}Mb</MetaRow>
            )}
            {spec?.cpuBudget !== undefined && (
              <MetaRow label={t('cpuBudgetLabel')}>{spec.cpuBudget}</MetaRow>
            )}
            <MetaRow label={t('versionsLabel')}>{detail.summary.versions.join(' · ')}</MetaRow>
          </div>
          {(detail.summary.capabilities ?? []).length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <SectionLabel>{t('capabilitiesLabel')}</SectionLabel>
              {(detail.summary.capabilities ?? []).map((c) => (
                <Badge key={c} tone="neutral">
                  {c}
                </Badge>
              ))}
            </div>
          )}
          {(spec?.tags ?? []).length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <SectionLabel>{t('tagsLabel')}</SectionLabel>
              {(spec?.tags ?? []).map((tag) => (
                <Badge key={tag} tone="neutral">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Self-hosted runner drill-in — presence/status from the polled roster + a recent-activity feed; clicking a run
// switches to the runs tab's live view (still inside the panel).
function RunnerDetail({
  id,
  meta,
  loading,
  onBack,
}: {
  id: string
  meta: RunnerMeta | undefined
  loading: boolean
  onBack: () => void
}) {
  const t = useTranslations('infraPanel')
  const { openRun } = useInfraPanel()
  const [activity, setActivity] = useState<Run[] | null>(null)

  useEffect(() => {
    setActivity(null)
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs?runner=${encodeURIComponent(id)}`, {
          cache: 'no-store',
        })
        if (res.ok) {
          const parsed = runsSchema.safeParse(await res.json())
          if (stopped) return
          if (parsed.success) setActivity(parsed.data)
        }
      } catch {
        // transient — keep polling
      }
      if (!stopped) timer = setTimeout(tick, 15_000)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [id])

  const online = isOnline(meta?.lastSeenAt)
  return (
    <div className="space-y-3 px-3.5 py-3">
      <DetailNav onBack={onBack} />
      <div className="flex flex-wrap items-center gap-2">
        <Laptop className="size-4 shrink-0 text-[#6ec6a8]" />
        <span className="min-w-0 truncate text-[13px] font-[560]">{meta?.label ?? id}</span>
        <Badge tone={online ? 'success' : 'neutral'}>{online ? t('online') : t('offline')}</Badge>
        {meta?.updateRequired && <Badge tone="info">{t('updateRequired')}</Badge>}
      </div>

      {!meta && !loading && (
        <p className="py-6 text-center text-[12.5px] text-faint">{t('detailMissing')}</p>
      )}

      {meta && (
        <>
          {meta.status && (
            <p
              className={cn(
                'text-[12px]',
                meta.status.level === 'error'
                  ? 'text-[var(--color-destructive)]'
                  : meta.status.level === 'warn'
                    ? 'text-[var(--color-warning)]'
                    : 'text-muted-foreground'
              )}
            >
              {meta.status.text}
            </p>
          )}
          <div className="rounded-md border bg-card px-2.5 py-1.5">
            {meta.os && <MetaRow label={t('osLabel')}>{meta.os}</MetaRow>}
            {meta.version && <MetaRow label={t('runnerVersionLabel')}>{meta.version}</MetaRow>}
            <MetaRow label={t('pairedAtLabel')}>{fmtDateTime(meta.pairedAt)}</MetaRow>
            {meta.lastSeenAt && (
              <MetaRow label={t('lastSeenLabel')}>{fmtDateTime(meta.lastSeenAt)}</MetaRow>
            )}
          </div>
          {meta.capabilities.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <SectionLabel>{t('capabilitiesLabel')}</SectionLabel>
              {meta.capabilities.map((c) => (
                <Badge key={c} tone="neutral">
                  {c}
                </Badge>
              ))}
            </div>
          )}
        </>
      )}

      <section className="space-y-1">
        <SectionLabel count={activity?.length}>{t('recentActivity')}</SectionLabel>
        {activity === null ? (
          <div className="flex items-center justify-center gap-2 py-4 text-[12.5px] text-faint">
            <Loader2 className="size-3.5 animate-spin" /> {t('loading')}
          </div>
        ) : activity.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-faint">{t('activityEmpty')}</p>
        ) : (
          <div className="space-y-1">
            {activity.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => openRun(r.id)}
                className="flex w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <StatusIcon status={r.status} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 space-y-0.5 overflow-hidden whitespace-nowrap">
                  <span className="block truncate text-[12px] font-[510]">
                    <EntityRef id={r.harness.id} version={r.harness.version} kind="harness" />
                  </span>
                  <span className="block truncate font-mono text-[10.5px] text-faint">
                    {r.caseId}
                  </span>
                </span>
                <time
                  className="w-[68px] shrink-0 text-right font-mono text-[10.5px] text-muted-foreground"
                  title={fmtDateTimeFull(r.createdAt)}
                >
                  {fmtDateTime(r.createdAt)}
                </time>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
