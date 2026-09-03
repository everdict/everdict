import { ChevronLeft } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { HarnessPicker, type HarnessOption } from '@/features/by-harness-scorecards'
import {
  scorecardGroupCountsSchema,
  scorecardsSchema,
  type ScorecardRecord,
} from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { MetricChip, ModelChip } from '@/shared/ui/chip'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

export const dynamic = 'force-dynamic'

// How much of ONE harness's history this screen draws. The picker's counts are exact whatever this is — they
// come from the server's aggregate, not from these rows — so a bounded page here costs depth, never accuracy.
const HARNESS_HISTORY = 200

export default async function ByHarnessPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ harness?: string }>
}) {
  const { workspace } = await params
  const { harness } = await searchParams
  const ctx = await authContext()
  const t = await getTranslations('scorecardsPage')
  const timeZone = await getTimeZone()

  // ── TWO NARROW READS, NOT ONE UNBOUNDED ONE (perf review) ──────────────────────────────────────
  //
  // This page used to read EVERY scorecard the workspace had ever produced — jsonb summaries and all — and
  // then count per harness and filter to one of them in JavaScript. The cost of drawing it grew with
  // everything the workspace had ever evaluated, and the counts in the picker were only right because the
  // read was unbounded: give that list a page size and the labels quietly become wrong, which is worse than
  // slow. The count is a question the server already answers exactly (`GET /scorecards/counts`), so the
  // narrowing that matters moves into the query and the page stays a page.
  //
  // Sequential on purpose: which harness is selected DEPENDS on the counts (the first option is the default),
  // so the second read cannot be issued until the first has answered.
  let error: string | undefined
  let options: HarnessOption[] = []
  try {
    const counts = scorecardGroupCountsSchema.parse(
      await controlPlane.countScorecards(ctx, 'harness')
    )
    options = counts.groups
      .flatMap((g) => (g.key === null ? [] : [g]))
      .sort((a, b) => (a.key ?? '').localeCompare(b.key ?? ''))
      .map((g) => ({ id: g.key ?? '', label: `${g.key} (${g.count})` }))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const selected = harness ?? options[0]?.id
  let rows: ScorecardRecord[] = []
  if (selected !== undefined && error === undefined) {
    try {
      rows = scorecardsSchema.parse(
        await controlPlane.listScorecards(ctx, { harness: selected, limit: HARNESS_HISTORY })
      )
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  // Group by dataset.id (each group is created desc). "What score this harness got on which benchmark with which model".
  const byDataset = new Map<string, ScorecardRecord[]>()
  for (const s of rows) {
    const arr = byDataset.get(s.dataset.id) ?? []
    arr.push(s)
    byDataset.set(s.dataset.id, arr)
  }
  const groups = [...byDataset.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [, arr] of groups) arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <Link
          href={`/${workspace}/scorecards`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {t('backToList')}
        </Link>
        <PageHeader title={t('byHarnessTitle')} description={t('byHarnessDescription')} />
      </div>

      {error && <Callout tone="danger">{t('listError', { error })}</Callout>}

      {options.length === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('byHarnessEmptyHint')} />
      ) : (
        <>
          <Card className="p-4">
            <HarnessPicker harnesses={options} harness={selected} />
          </Card>

          {groups.length === 0 ? (
            <EmptyState title={t('noScorecardsForHarness')} />
          ) : (
            groups.map(([datasetId, cards]) => (
              <section key={datasetId} className="space-y-2.5">
                <SectionHeader
                  title={datasetId}
                  action={
                    <span className="text-[11px] text-faint">
                      {t('countItems', { count: cards.length })}
                    </span>
                  }
                />
                <Table>
                  <THead>
                    <tr>
                      <TH>{t('thHarnessVersion')}</TH>
                      <TH>model</TH>
                      <TH>metrics</TH>
                      <TH className="text-right">{t('thStatus')}</TH>
                      <TH className="text-right">{t('thTime')}</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {cards.map((s) => (
                      <TR key={s.id}>
                        <TD>
                          <Link
                            href={`/${workspace}/scorecard/${encodeURIComponent(s.id)}`}
                            className="font-mono text-[12px] font-[510] text-link transition-colors hover:text-foreground"
                          >
                            @{s.harness.version}
                            <span className="text-faint"> · ds {s.dataset.version}</span>
                          </Link>
                        </TD>
                        <TD>
                          {s.models?.primary ? (
                            <ModelChip>{s.models.primary}</ModelChip>
                          ) : (
                            <span className="text-[12px] text-faint">unknown</span>
                          )}
                        </TD>
                        <TD>
                          <div className="flex flex-wrap gap-1">
                            {(s.summary ?? []).length > 0 ? (
                              (s.summary ?? []).map((m) => (
                                <MetricChip
                                  key={m.metric}
                                  metric={m.metric}
                                  mean={m.mean}
                                  passRate={m.passRate}
                                  unmeasured={m.unmeasured}
                                  siblings={(s.summary ?? []).map((x) => x.metric)}
                                />
                              ))
                            ) : (
                              <span className="text-[11px] text-faint">–</span>
                            )}
                          </div>
                        </TD>
                        <TD className="text-right">
                          <StatusPill status={s.status} />
                        </TD>
                        <TD
                          className="whitespace-nowrap text-right font-mono text-[11px] text-muted-foreground"
                          title={fmtDateTimeFull(s.createdAt, { timeZone })}
                        >
                          {fmtDateTime(s.createdAt, timeZone)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </section>
            ))
          )}
        </>
      )}
    </div>
  )
}
