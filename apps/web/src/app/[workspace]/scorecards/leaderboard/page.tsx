import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { LeaderboardPicker, type DatasetOption } from '@/features/leaderboard-scorecards'
import { datasetsSchema } from '@/entities/dataset'
import { leaderboardSchema, type Leaderboard } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull, fmtMetricLabel } from '@/shared/lib/format'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { ModelChip } from '@/shared/ui/chip'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { Score } from '@/shared/ui/score'
import { SectionHeader } from '@/shared/ui/section-header'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

export const dynamic = 'force-dynamic'

// Rank medal — 1st gold (amber) · 2nd silver (neutral) · 3rd bronze · otherwise plain. Top ranks at a glance.
function RankBadge({ rank }: { rank: number }) {
  const base =
    'inline-flex size-5 items-center justify-center rounded-full text-[11px] font-[560] tabular-nums ring-1 ring-inset'
  if (rank === 1)
    return (
      <span
        className={`${base} bg-[var(--color-warning)]/15 text-[var(--color-warning)] ring-[var(--color-warning)]/30`}
      >
        1
      </span>
    )
  if (rank === 2)
    return <span className={`${base} bg-secondary text-secondary-foreground ring-border`}>2</span>
  if (rank === 3)
    return <span className={`${base} bg-[#cd7f32]/15 text-[#cd7f32] ring-[#cd7f32]/30`}>3</span>
  return <span className="pr-1 font-mono text-[12px] tabular-nums text-faint">{rank}</span>
}

export default async function LeaderboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ dataset?: string; metric?: string; window?: string; judgeModel?: string }>
}) {
  const { workspace } = await params
  const { dataset, metric, window, judgeModel } = await searchParams
  const ctx = await authContext()
  const t = await getTranslations('scorecardsPage')
  const timeZone = await getTimeZone()

  let options: DatasetOption[] = []
  try {
    options = datasetsSchema
      .parse(await controlPlane.listDatasets(ctx))
      .map((d) => ({ id: d.id, label: `${d.id} (${d.versions.length}v)` }))
  } catch {
    // Even if the list fails, still show guidance
  }

  let board: Leaderboard | undefined
  let error: string | undefined
  if (dataset) {
    try {
      board = leaderboardSchema.parse(
        await controlPlane.leaderboardScorecards(ctx, {
          dataset,
          metric: metric ?? 'judge',
          window: window === 'best' ? 'best' : 'latest',
          ...(judgeModel ? { judgeModel } : {}),
        })
      )
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

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
        <PageHeader title={t('leaderboardTitle')} description={t('leaderboardDescription')} />
      </div>

      {options.length === 0 ? (
        <EmptyState title={t('noDatasetsTitle')} hint={t('leaderboardEmptyHint')} />
      ) : (
        <Card className="p-4">
          <LeaderboardPicker
            datasets={options}
            dataset={dataset}
            metric={metric}
            window={window}
            judgeModel={judgeModel}
          />
        </Card>
      )}

      {error && <Callout tone="danger">{t('leaderboardLoadError', { error })}</Callout>}

      {board && (
        <div className="space-y-4">
          <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
            <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
              {board.dataset}
            </code>
            · metric
            <code
              title={board.metric}
              className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
            >
              {fmtMetricLabel(board.metric)}
            </code>
            · {t('aggregationLabel')}
            <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
              {board.window}
            </code>
          </p>

          {board.rows.length === 0 ? (
            <EmptyState title={t('noMatchTitle')} hint={t('leaderboardNoMatchHint')} />
          ) : (
            <section className="space-y-2.5">
              <SectionHeader title={t('rankingTitle', { count: board.rows.length })} />
              <Table>
                <THead>
                  <tr>
                    <TH className="w-12 text-right">#</TH>
                    <TH>harness</TH>
                    <TH>model</TH>
                    <TH>judge</TH>
                    <TH className="text-right" title={board.metric}>
                      {fmtMetricLabel(board.metric)}
                    </TH>
                    <TH className="text-right">runs</TH>
                    <TH className="text-right">{t('thCreated')}</TH>
                  </tr>
                </THead>
                <TBody>
                  {board.rows.map((r) => (
                    <TR key={`${r.harness.id}@${r.harness.version}-${r.model ?? 'unknown'}`}>
                      <TD className="text-center">
                        <RankBadge rank={r.rank} />
                      </TD>
                      <TD>
                        <Link
                          href={`/${workspace}/scorecards/${r.scorecardId}`}
                          className="font-mono text-[12px] font-[510] text-link transition-colors hover:text-foreground"
                        >
                          {r.harness.id}
                          <span className="text-faint">@{r.harness.version}</span>
                        </Link>
                      </TD>
                      <TD>
                        {r.model ? (
                          <ModelChip>{r.model}</ModelChip>
                        ) : (
                          <span className="text-[12px] text-faint">unknown</span>
                        )}
                      </TD>
                      <TD>
                        {r.judgeModels && r.judgeModels.length > 0 ? (
                          <span className="flex flex-wrap gap-1">
                            {r.judgeModels.map((jm) => (
                              <ModelChip key={jm} muted>
                                {jm}
                              </ModelChip>
                            ))}
                          </span>
                        ) : (
                          <span className="text-[12px] text-faint">–</span>
                        )}
                      </TD>
                      <TD className="text-right">
                        <Score passRate={r.passRate} mean={r.mean} />
                      </TD>
                      <TD className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                        {r.runs}
                      </TD>
                      <TD
                        className="whitespace-nowrap text-right font-mono text-[11px] text-muted-foreground"
                        title={fmtDateTimeFull(r.createdAt, { timeZone })}
                      >
                        {fmtDateTime(r.createdAt, timeZone)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
