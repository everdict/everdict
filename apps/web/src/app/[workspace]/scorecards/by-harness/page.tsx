import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { HarnessPicker, type HarnessOption } from '@/features/by-harness-scorecards'
import { scorecardsSchema, type ScorecardRecord } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { MetricChip, ModelChip } from '@/shared/ui/chip'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

export const dynamic = 'force-dynamic'

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

  let error: string | undefined
  let scorecards: ScorecardRecord[] = []
  try {
    scorecards = scorecardsSchema.parse(await controlPlane.listScorecards(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // harness 옵션 = 스코어카드에 등장한 distinct harness id(개수 라벨).
  const counts = new Map<string, number>()
  for (const s of scorecards) counts.set(s.harness.id, (counts.get(s.harness.id) ?? 0) + 1)
  const options: HarnessOption[] = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, n]) => ({ id, label: `${id} (${n})` }))

  const selected = harness ?? options[0]?.id
  const rows = selected ? scorecards.filter((s) => s.harness.id === selected) : []

  // dataset.id 별 그룹(각 그룹은 created desc). "이 harness 가 어떤 벤치마크에서 어떤 model 로 어떤 점수를".
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
                            href={`/${workspace}/scorecards/${encodeURIComponent(s.id)}`}
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
                          title={fmtDateTimeFull(s.createdAt)}
                        >
                          {fmtDateTime(s.createdAt)}
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
