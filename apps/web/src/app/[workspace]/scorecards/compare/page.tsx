import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { ComparePicker, type CompareOption } from '@/features/compare-scorecards'
import { scorecardDiffSchema, scorecardsSchema, type ScorecardDiff } from '@/entities/scorecard'
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

function delta(n: number): string {
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '–'
  return `${arrow} ${n > 0 ? '+' : ''}${n.toFixed(2)}`
}

export default async function CompareScorecardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ baseline?: string; candidate?: string }>
}) {
  const { workspace } = await params
  const { baseline, candidate } = await searchParams
  const ctx = await authContext()

  // 비교는 완료된 스코어카드만(미완료는 diff 불가).
  let options: CompareOption[] = []
  let baselineModel: string | undefined
  let candidateModel: string | undefined
  try {
    const all = scorecardsSchema.parse(await controlPlane.listScorecards(ctx))
    options = all
      .filter((s) => s.status === 'succeeded')
      .map((s) => ({
        id: s.id,
        label: `${s.dataset.id}@${s.dataset.version} → ${s.harness.id}@${s.harness.version}`,
      }))
    // 각 side 의 model(선택된 스코어카드 레코드에서) — 헤더에 곁들여 표시.
    const byId = new Map(all.map((s) => [s.id, s]))
    baselineModel = baseline ? byId.get(baseline)?.models?.primary : undefined
    candidateModel = candidate ? byId.get(candidate)?.models?.primary : undefined
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
        <Card className="p-4">
          <ComparePicker options={options} baseline={baseline} candidate={candidate} />
        </Card>
      )}

      {error && <Callout tone="danger">비교 실패: {error}</Callout>}

      {diff && (
        <div className="space-y-7">
          <section className="space-y-2.5">
            <SectionHeader title="메트릭 변화" />
            <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
              baseline
              <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
                {diff.baseline}
              </code>
              {baselineModel && (
                <code className="rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground">
                  {baselineModel}
                </code>
              )}
              vs candidate
              <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
                {diff.candidate}
              </code>
              {candidateModel && (
                <code className="rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground">
                  {candidateModel}
                </code>
              )}
            </p>
            <Table>
              <THead>
                <tr>
                  <TH>metric</TH>
                  <TH className="text-right">baseline</TH>
                  <TH className="text-right">candidate</TH>
                  <TH className="text-right">Δ</TH>
                </tr>
              </THead>
              <TBody>
                {diff.metrics.map((m) => (
                  <TR key={m.metric}>
                    <TD className="font-mono text-[12px] font-[510]">{m.metric}</TD>
                    <TD className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                      {m.baselineMean.toFixed(2)}
                    </TD>
                    <TD className="text-right font-mono text-[12px] tabular-nums">
                      {m.candidateMean.toFixed(2)}
                    </TD>
                    <TD
                      className={`text-right font-mono text-[12px] tabular-nums ${
                        m.delta === 0
                          ? 'text-muted-foreground'
                          : m.delta > 0
                            ? 'font-[510] text-[var(--color-success)]'
                            : 'font-[510] text-destructive'
                      }`}
                    >
                      {delta(m.delta)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </section>

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
    <Card className="space-y-2.5 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-[560]">{title}</h2>
        <Badge tone={tone}>{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1 text-[13px]">
          {items.map((d) => (
            <li key={`${d.caseId}:${d.metric}`} className="flex items-center justify-between gap-2">
              <span className="font-mono text-[12px]">
                {d.caseId} · {d.metric}
              </span>
              <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
                {d.baseline} → {d.candidate}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
