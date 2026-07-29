'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { ScorecardRecord } from '@/entities/scorecard'
import { fmtDateTime } from '@/shared/lib/format'
import { OriginChip } from '@/shared/ui/origin'
import { Score } from '@/shared/ui/score'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

import { scoreOfScorecard } from '../model/analysis'

// The rows the aggregate was computed from. Every chart above this table is a summary of exactly these
// records, so nothing the chart encodes with color or length is readable only there — this is the table-view
// twin, and the drill-down target when a mark is clicked.

const PAGE = 50

export function RawRowsTable({
  rows,
  metric,
  focusLabel,
  onClearFocus,
}: {
  rows: ScorecardRecord[]
  metric?: string
  /** Set when a mark was clicked — the table is scoped to that group until it is cleared. */
  focusLabel?: string
  onClearFocus?: () => void
}) {
  const t = useTranslations('analyzeScorecards')
  const { workspace } = useParams<{ workspace: string }>()
  const [expanded, setExpanded] = useState(false)

  const sorted = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const shown = expanded ? sorted : sorted.slice(0, PAGE)

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-[560] text-foreground">{t('rawTitle')}</h3>
        <span className="text-[11px] text-faint">{t('rawCount', { count: rows.length })}</span>
        {focusLabel && onClearFocus && (
          <button
            type="button"
            onClick={onClearFocus}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('rawFocused', { label: focusLabel })}
            <X className="size-3" />
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border bg-card px-3 py-6 text-center text-[13px] text-muted-foreground">
          {t('rawEmpty')}
        </p>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>{t('rawColRan')}</TH>
                <TH>{t('filterBenchmark')}</TH>
                <TH>{t('harness')}</TH>
                <TH>{t('filterModel')}</TH>
                <TH>{t('filterStatus')}</TH>
                <TH className="text-right">{t('rawColScore')}</TH>
                <TH className="text-right">{t('rawColCases')}</TH>
                <TH>{t('filterOrigin')}</TH>
              </tr>
            </THead>
            <TBody>
              {shown.map((sc) => {
                const score = scoreOfScorecard(sc, metric)
                const model = sc.models?.primary ?? sc.models?.observed?.[0]
                return (
                  <TR key={sc.id}>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      <Link
                        href={`/${workspace}/scorecards/${sc.id}`}
                        className="hover:text-foreground hover:underline"
                      >
                        {fmtDateTime(sc.createdAt)}
                      </Link>
                    </TD>
                    <TD className="font-[510]">
                      {sc.dataset.id}
                      <span className="text-faint">@{sc.dataset.version}</span>
                    </TD>
                    <TD className="font-[510]">
                      {sc.harness.id}
                      <span className="text-faint">@{sc.harness.version}</span>
                    </TD>
                    <TD className="text-muted-foreground">{model ?? '—'}</TD>
                    <TD>
                      <StatusPill status={sc.status} />
                    </TD>
                    <TD className="text-right">
                      {score === undefined ? (
                        <span className="text-faint">–</span>
                      ) : (
                        // Values <= 1 are the pass-rate shape the health tones are for; anything larger is
                        // a raw numeric metric and stays neutral.
                        <Score
                          {...(score <= 1 ? { passRate: score } : {})}
                          {...(score > 1 ? { mean: score } : {})}
                        />
                      )}
                    </TD>
                    <TD className="text-right tabular-nums text-muted-foreground">
                      {sc.casePass ? `${sc.casePass.pass}/${sc.casePass.total}` : '—'}
                    </TD>
                    <TD>
                      {sc.origin ? (
                        <OriginChip origin={sc.origin} />
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </TD>
                  </TR>
                )
              })}
            </TBody>
          </Table>

          {/* Never cap silently — say what is hidden and offer the rest. */}
          {sorted.length > shown.length && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full rounded-md border border-border bg-card py-1.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('rawShowAll', { shown: shown.length, total: sorted.length })}
            </button>
          )}
        </>
      )}
    </section>
  )
}
