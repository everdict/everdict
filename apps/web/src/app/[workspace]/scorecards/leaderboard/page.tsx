import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { LeaderboardPicker, type DatasetOption } from '@/features/leaderboard-scorecards'
import { datasetsSchema } from '@/entities/dataset'
import { leaderboardSchema, type Leaderboard } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

export const dynamic = 'force-dynamic'

function fmtScore(r: Leaderboard['rows'][number]): string {
  if (r.passRate !== null) return `${Math.round(r.passRate * 100)}%`
  if (r.mean !== null) return r.mean.toFixed(2)
  return '–'
}
function fmtTime(iso: string): string {
  return iso
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z')
    .slice(0, 16)
}

// rank 1 은 성공 톤, 2~3 은 info, 그 외 muted(neutral).
function rankTone(rank: number): 'success' | 'info' | 'neutral' {
  if (rank === 1) return 'success'
  if (rank <= 3) return 'info'
  return 'neutral'
}

export default async function LeaderboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ dataset?: string; metric?: string; window?: string }>
}) {
  const { workspace } = await params
  const { dataset, metric, window } = await searchParams
  const ctx = await authContext()

  let options: DatasetOption[] = []
  try {
    options = datasetsSchema
      .parse(await controlPlane.listDatasets(ctx))
      .map((d) => ({ id: d.id, label: `${d.id} (${d.versions.length}v)` }))
  } catch {
    // 목록 실패해도 안내는 보여준다
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
          스코어카드
        </Link>
        <PageHeader
          title="리더보드"
          description="한 벤치마크(데이터셋)에서 harness × model 을 점수로 랭킹 — 리더보드처럼."
        />
      </div>

      {options.length === 0 ? (
        <EmptyState
          title="데이터셋이 없습니다."
          hint="벤치마크/데이터셋을 등록하고 여러 harness·model 로 평가하면 리더보드가 채워집니다."
        />
      ) : (
        <Card className="p-4">
          <LeaderboardPicker datasets={options} dataset={dataset} metric={metric} window={window} />
        </Card>
      )}

      {error && <Callout tone="danger">리더보드 조회 실패: {error}</Callout>}

      {board && (
        <div className="space-y-4">
          <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
            <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
              {board.dataset}
            </code>
            · metric
            <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
              {board.metric}
            </code>
            · 집계
            <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
              {board.window}
            </code>
          </p>

          {board.rows.length === 0 ? (
            <EmptyState
              title="이 조건의 완료 스코어카드가 없습니다."
              hint="선택한 데이터셋을 harness 에 돌리면(metric 이 산출되면) 여기 랭킹됩니다."
            />
          ) : (
            <section className="space-y-2.5">
              <SectionHeader title={`랭킹 (${board.rows.length})`} />
              <Table>
                <THead>
                  <tr>
                    <TH className="w-12 text-right">#</TH>
                    <TH>harness</TH>
                    <TH>model</TH>
                    <TH className="text-right">{board.metric}</TH>
                    <TH className="text-right">runs</TH>
                    <TH className="text-right">최근</TH>
                  </tr>
                </THead>
                <TBody>
                  {board.rows.map((r) => (
                    <TR key={`${r.harness.id}@${r.harness.version}-${r.model ?? 'unknown'}`}>
                      <TD className="text-right">
                        <Badge tone={rankTone(r.rank)}>{r.rank}</Badge>
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
                          <code className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground">
                            {r.model}
                          </code>
                        ) : (
                          <span className="text-faint text-[12px]">unknown</span>
                        )}
                      </TD>
                      <TD className="text-right font-mono text-[12px] font-[510] tabular-nums">
                        {fmtScore(r)}
                      </TD>
                      <TD className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                        {r.runs}
                      </TD>
                      <TD className="whitespace-nowrap text-right font-mono text-[11px] text-muted-foreground">
                        {fmtTime(r.createdAt)}
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
