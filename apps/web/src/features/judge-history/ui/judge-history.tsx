'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import type { ScorecardStatus } from '@/entities/scorecard'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { EntityRef, MetricChip } from '@/shared/ui/chip'
import { Link } from '@/shared/ui/link'
import { StatusIcon } from '@/shared/ui/status-pill'

// How many to show per page — it stops a large initial render and reveals ten at a time through "show more".
const PAGE_SIZE = 10

// The minimum data one evaluation-history row needs (assembled on the server and passed down — a serializable flat shape).
export interface JudgeHistoryEntry {
  id: string
  dataset: { id: string; version?: string }
  harness: { id: string; version?: string }
  // Only this judge's metrics (overall plus its criteria) — the chips render in the compact form (with the judge id omitted).
  // mean is ABSENT when the metric had zero measurements (the judge crashed on every case) — the chip then
  // shows the unmeasured marker instead of a fabricated 0.00 on the judge's own health screen.
  metrics: { metric: string; mean?: number; passRate?: number | null; unmeasured?: number }[]
  runner?: { name: string; avatarUrl?: string }
  createdAt: string
  status: ScorecardStatus
}

// The judge detail's evaluation history list.
// - Pagination: ten are shown and "show more" continues.
// - Layout priority: the dataset and harness do NOT shrink (priority width), and the judge metric chips are abbreviated or clipped first.
export function JudgeHistory({
  workspace,
  entries,
  timeZone,
}: {
  workspace: string
  entries: JudgeHistoryEntry[]
  timeZone: string
}) {
  const t = useTranslations('judgesPage')
  const [visible, setVisible] = useState(PAGE_SIZE)
  const shown = entries.slice(0, visible)
  const remaining = entries.length - shown.length

  return (
    <div className="space-y-2">
      {shown.map((s) => {
        const siblings = s.metrics.map((m) => m.metric)
        return (
          <Link
            key={s.id}
            href={`/${workspace}/scorecard/${encodeURIComponent(s.id)}`}
            className="group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
          >
            {/* Dataset · harness — priority width (content width preserved). flex-basis 0 absorbs the slack, and only an extremely long id truncates. */}
            <div className="flex min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap text-[13px] font-[510]">
              <span className="truncate">
                <EntityRef id={s.dataset.id} version={s.dataset.version} kind="dataset" />
              </span>
              <span className="shrink-0 text-faint">·</span>
              <span className="truncate">
                <EntityRef id={s.harness.id} version={s.harness.version} kind="harness" />
              </span>
            </div>
            {/* Judge metrics — 'judge <id>' is redundant on a judge page, so it is abbreviated to compact. When space runs short
                (shrink + overflow-hidden) this column is clipped before the dataset and harness. */}
            <div className="hidden min-w-0 shrink items-center justify-end gap-1 overflow-hidden sm:flex">
              {s.metrics.slice(0, 2).map((m) => (
                <span key={m.metric} className="shrink-0">
                  <MetricChip
                    metric={m.metric}
                    mean={m.mean}
                    passRate={m.passRate}
                    unmeasured={m.unmeasured}
                    siblings={siblings}
                    compact
                  />
                </span>
              ))}
              {s.metrics.length > 2 && (
                <span className="shrink-0 text-[11px] text-faint">+{s.metrics.length - 2}</span>
              )}
            </div>
            {/* Who ran it · when · status — fixed width */}
            <div className="flex shrink-0 items-center gap-2.5">
              <span className="flex w-6 justify-center">
                {s.runner && (
                  <UserAvatar
                    name={s.runner.name}
                    url={s.runner.avatarUrl}
                    label={t('evaluationHistoryRunner')}
                  />
                )}
              </span>
              <time
                className="hidden w-[84px] text-right font-mono text-[11px] text-muted-foreground sm:block"
                title={fmtDateTimeFull(s.createdAt, { timeZone })}
              >
                {fmtDateTime(s.createdAt, timeZone)}
              </time>
              <span className="flex w-5 justify-end">
                <StatusIcon status={s.status} />
              </span>
            </div>
          </Link>
        )
      })}
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
          className="w-full rounded-lg border border-dashed border-border px-3.5 py-2 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:bg-elevated hover:text-foreground"
        >
          {t('evaluationHistoryLoadMore', { count: remaining })}
        </button>
      )}
    </div>
  )
}
