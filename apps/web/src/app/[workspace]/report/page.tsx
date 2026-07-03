import Link from 'next/link'
import { BarChart3 } from 'lucide-react'

import {
  casePass,
  scorecardRecordSchema,
  scorecardsSchema,
  trackOf,
  type ScorecardRecord,
} from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatCard } from '@/shared/ui/stat-card'

export const dynamic = 'force-dynamic'

// 데스크탑 + 웹 통합 리포트: 같은 CaseResult→Scorecard 흐름으로 평가한 서로 다른 하니스/벤치마크를 트랙별로 묶어
// 권위-기준(state > 객관 > judge) 케이스 통과율을 한 화면에. 하니스/인프라-비종속 평가 런타임의 단일 리포트.
const TRACK_LABEL: Record<string, string> = {
  desktop: '데스크탑 · OSWorld',
  web: '웹 · WebVoyager',
  other: '기타',
}
const TRACK_ORDER = ['desktop', 'web', 'other'] as const

function pct(pass: number, total: number): string {
  return total > 0 ? `${Math.round((pass / total) * 100)}%` : '—'
}

export default async function ReportPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const ctx = await authContext()
  let records: ScorecardRecord[] = []
  let error: string | undefined
  try {
    records = scorecardsSchema.parse(await controlPlane.listScorecards(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // 리스트는 summary 만 주므로(케이스 results 없음) 완료분은 full 레코드를 받아 권위-기준 case-pass 를 계산.
  const listed = records.filter((r) => r.status === 'succeeded')
  const succeeded = await Promise.all(
    listed.map(async (r) => {
      try {
        return scorecardRecordSchema.parse(await controlPlane.getScorecard(ctx, r.id))
      } catch {
        return r
      }
    })
  )
  const byTrack: Record<string, ScorecardRecord[]> = { desktop: [], web: [], other: [] }
  for (const r of succeeded) byTrack[trackOf(r)].push(r)

  let combPass = 0
  let combTotal = 0
  for (const r of succeeded) {
    const cp = casePass(r)
    combPass += cp.pass
    combTotal += cp.total
  }

  return (
    <div className="space-y-7">
      <PageHeader
        title="통합 리포트"
        description="데스크탑과 웹에서 실행한 평가를 한눈에 봐요."
      />

      {error && <Callout tone="danger">스코어카드를 불러오지 못했어요: {error}</Callout>}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <StatCard
          label="전체 통과율"
          value={pct(combPass, combTotal)}
          hint={`${combPass}/${combTotal} 케이스`}
          tone={combTotal > 0 && combPass === combTotal ? 'success' : 'primary'}
        />
        {TRACK_ORDER.filter((t) => byTrack[t].length > 0).map((t) => {
          const p = byTrack[t].reduce(
            (acc, r) => {
              const cp = casePass(r)
              return { pass: acc.pass + cp.pass, total: acc.total + cp.total }
            },
            { pass: 0, total: 0 }
          )
          return (
            <StatCard
              key={t}
              label={TRACK_LABEL[t]}
              value={pct(p.pass, p.total)}
              hint={`${p.pass}/${p.total} · 스코어카드 ${byTrack[t].length}`}
              tone="default"
            />
          )
        })}
      </div>

      {TRACK_ORDER.filter((t) => byTrack[t].length > 0).map((t) => (
        <section key={t} className="space-y-2.5">
          <SectionHeader title={TRACK_LABEL[t]} />
          <div className="space-y-2">
            {byTrack[t].map((r) => {
              const cp = casePass(r)
              const allPass = cp.total > 0 && cp.pass === cp.total
              return (
                <Link
                  key={r.id}
                  href={`/${workspace}/scorecards/${r.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
                >
                  <span className="min-w-0 truncate font-mono text-[13px] font-[510] text-foreground">
                    {r.dataset.id}
                    <span className="text-faint">@{r.dataset.version}</span>
                    <span className="px-1 text-muted-foreground">→</span>
                    {r.harness.id}
                    <span className="text-faint">@{r.harness.version}</span>
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
                      <span className="text-faint">통과</span> {cp.pass}/{cp.total} (
                      {pct(cp.pass, cp.total)})
                    </span>
                    <Badge tone={allPass ? 'success' : cp.pass > 0 ? 'info' : 'danger'}>
                      {allPass ? '전체 통과' : `${cp.total - cp.pass}건 실패`}
                    </Badge>
                  </div>
                </Link>
              )
            })}
          </div>
        </section>
      ))}

      {succeeded.length === 0 && !error && (
        <EmptyState
          icon={<BarChart3 />}
          title="아직 완료된 스코어카드가 없어요."
          hint="스코어카드를 실행하면 결과가 여기에 모여요."
        />
      )}
    </div>
  )
}
