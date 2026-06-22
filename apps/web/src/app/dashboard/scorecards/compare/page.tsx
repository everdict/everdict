import Link from 'next/link'

import { ComparePicker, type CompareOption } from '@/features/compare-scorecards'
import { scorecardDiffSchema, scorecardsSchema, type ScorecardDiff } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card, CardContent } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

function delta(n: number): string {
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '–'
  return `${arrow} ${n > 0 ? '+' : ''}${n.toFixed(2)}`
}

export default async function CompareScorecardsPage({
  searchParams,
}: {
  searchParams: Promise<{ baseline?: string; candidate?: string }>
}) {
  const { baseline, candidate } = await searchParams
  const ctx = await authContext()

  // 비교는 완료된 스코어카드만(미완료는 diff 불가).
  let options: CompareOption[] = []
  try {
    const all = scorecardsSchema.parse(await controlPlane.listScorecards(ctx))
    options = all
      .filter((s) => s.status === 'succeeded')
      .map((s) => ({
        id: s.id,
        label: `${s.dataset.id}@${s.dataset.version} → ${s.harness.id}@${s.harness.version}`,
      }))
  } catch {
    // 목록 실패해도 페이지는 안내를 보여준다
  }

  let diff: ScorecardDiff | undefined
  let error: string | undefined
  if (baseline && candidate) {
    try {
      diff = scorecardDiffSchema.parse(await controlPlane.diffScorecards(ctx, baseline, candidate))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/dashboard/scorecards"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          ← 스코어카드
        </Link>
        <PageHeader
          title="스코어카드 비교"
          description="baseline vs candidate — 메트릭 변화 + 케이스 회귀/개선."
        />
      </div>

      {options.length < 2 ? (
        <EmptyState
          title="비교하려면 완료된 스코어카드가 2개 이상 필요합니다."
          hint="같은 데이터셋을 두 하니스@버전(또는 두 번)으로 돌린 뒤 비교하세요."
        />
      ) : (
        <Card className="p-5">
          <ComparePicker options={options} baseline={baseline} candidate={candidate} />
        </Card>
      )}

      {error && <Callout tone="danger">비교 실패: {error}</Callout>}

      {diff && (
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-5">
              <div className="mb-3 text-sm text-muted-foreground">
                baseline{' '}
                <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs">
                  {diff.baseline}
                </code>{' '}
                vs candidate{' '}
                <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs">
                  {diff.candidate}
                </code>
              </div>
              <div className="overflow-hidden rounded-xl border bg-card">
                <table className="w-full text-sm">
                  <thead className="border-b border-border/70 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">metric</th>
                      <th className="px-4 py-2.5 text-right font-medium">baseline</th>
                      <th className="px-4 py-2.5 text-right font-medium">candidate</th>
                      <th className="px-4 py-2.5 text-right font-medium">Δ</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-nums">
                    {diff.metrics.map((m) => (
                      <tr
                        key={m.metric}
                        className="border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50"
                      >
                        <td className="px-4 py-2.5 font-sans">{m.metric}</td>
                        <td className="px-4 py-2.5 text-right">{m.baselineMean.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right">{m.candidateMean.toFixed(2)}</td>
                        <td
                          className={`px-4 py-2.5 text-right ${
                            m.delta === 0
                              ? 'text-muted-foreground'
                              : m.delta > 0
                                ? 'font-semibold text-[var(--color-success)]'
                                : 'font-semibold text-destructive'
                          }`}
                        >
                          {delta(m.delta)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <DeltaList
              title="회귀 (pass → fail)"
              tone="danger"
              items={diff.regressions}
              empty="회귀 없음"
            />
            <DeltaList
              title="개선 (fail → pass)"
              tone="success"
              items={diff.improvements}
              empty="개선 없음"
            />
          </section>
        </div>
      )}
    </div>
  )
}

function DeltaList({
  title,
  tone,
  items,
  empty,
}: {
  title: string
  tone: 'danger' | 'success'
  items: ScorecardDiff['regressions']
  empty: string
}) {
  return (
    <Card>
      <CardContent className="space-y-2 pt-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Badge tone={tone}>{items.length}</Badge>
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {items.map((d) => (
              <li
                key={`${d.caseId}:${d.metric}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="font-mono">
                  {d.caseId} · {d.metric}
                </span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  {d.baseline} → {d.candidate}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
