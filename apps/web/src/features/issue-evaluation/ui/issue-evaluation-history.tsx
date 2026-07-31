'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Flag, Pin } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { ScorecardStatus } from '@/entities/scorecard'
import { fmtDateTime, fmtDateTimeFull, fmtPct } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { EntityRef } from '@/shared/ui/chip'
import { StatusIcon } from '@/shared/ui/status-pill'
import { Tooltip } from '@/shared/ui/tooltip'

// How many rows to show before "load more" — the same progressive reveal the judge history uses.
const PAGE_SIZE = 10

// One row of the issue's evaluation history, assembled server-side into a flat serializable shape.
export interface IssueEvaluationEntry {
  id: string
  dataset: { id: string; version?: string }
  harness: { id: string; version?: string }
  passRate?: number | null
  status: ScorecardStatus
  createdAt: string
  // Explicitly linked to the issue as evidence, rather than derived from a linked dataset/harness.
  pinned: boolean
  // The scorecard the issue was CLOSED with — the baseline a regression is measured against.
  baseline: boolean
}

// The issue's evaluation history: pinned evidence ∪ every batch its linked datasets/harnesses ran. The second
// half is where a regression against a closed issue actually surfaces — nobody re-links a scorecard that has
// not happened yet, but the nightly batch on the linked dataset runs anyway.
export function IssueEvaluationHistory({
  workspace,
  entries,
  timeZone,
}: {
  workspace: string
  entries: IssueEvaluationEntry[]
  timeZone: string
}) {
  const t = useTranslations('issuesPage')
  const [visible, setVisible] = useState(PAGE_SIZE)
  const shown = entries.slice(0, visible)
  const remaining = entries.length - shown.length

  return (
    <div className="space-y-2">
      {shown.map((entry) => (
        <Link
          key={entry.id}
          href={`/${workspace}/scorecards/${encodeURIComponent(entry.id)}`}
          className="group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap text-[13px] font-[510]">
            <span className="truncate">
              <EntityRef id={entry.dataset.id} version={entry.dataset.version} kind="dataset" />
            </span>
            <span className="shrink-0 text-faint">·</span>
            <span className="truncate">
              <EntityRef id={entry.harness.id} version={entry.harness.version} kind="harness" />
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            {entry.baseline && (
              <Badge tone="info">
                <Flag className="size-3" strokeWidth={2} />
                {t('evaluationBaseline')}
              </Badge>
            )}
            {entry.pinned && !entry.baseline && (
              <Tooltip content={t('evaluationPinned')} align="end">
                <span aria-label={t('evaluationPinned')} className="inline-flex text-faint">
                  <Pin className="size-3.5" strokeWidth={1.75} />
                </span>
              </Tooltip>
            )}
            <span className="w-12 text-right font-mono text-[12px] tabular-nums text-muted-foreground">
              {entry.passRate == null ? '—' : fmtPct(entry.passRate)}
            </span>
            <time
              className="hidden w-[84px] text-right font-mono text-[11px] text-muted-foreground sm:block"
              title={fmtDateTimeFull(entry.createdAt, { timeZone })}
            >
              {fmtDateTime(entry.createdAt, timeZone)}
            </time>
            <span className="flex w-5 justify-end">
              <StatusIcon status={entry.status} />
            </span>
          </div>
        </Link>
      ))}
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
          className="w-full rounded-lg border border-dashed border-border px-3.5 py-2 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:bg-elevated hover:text-foreground"
        >
          {t('evaluationLoadMore', { count: remaining })}
        </button>
      )}
    </div>
  )
}
