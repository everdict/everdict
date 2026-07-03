import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { ComparePicker, type CompareOption } from '@/features/compare-scorecards'
import { scorecardDiffSchema, scorecardsSchema, type ScorecardDiff } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { ModelChip } from '@/shared/ui/chip'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

export const dynamic = 'force-dynamic'

function delta(n: number): string {
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '–'
  return `${arrow} ${n > 0 ? '+' : ''}${n.toFixed(2)}`
}

// 한 side(baseline/candidate) 헤더 — 스코어카드 상세로 링크 + 사용 모델 칩.
function SideRef({
  workspace,
  label,
  id,
  model,
}: {
  workspace: string
  label: string
  id: string
  model?: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-faint">{label}</span>
      <Link
        href={`/${workspace}/scorecards/${encodeURIComponent(id)}`}
        className="font-mono text-[12px] font-[510] text-link transition-colors hover:text-foreground"
        title={id}
      >
        {id.slice(0, 8)}
      </Link>
      {model && <ModelChip>{model}</ModelChip>}
    </span>
  )
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
          description="두 스코어카드를 비교해 점수가 어떻게 달라졌는지 봐요."
        />
      </div>

      {options.length < 2 ? (
        <EmptyState
          title="비교하려면 완료된 스코어카드가 2개 이상 필요해요."
          hint="같은 벤치마크를 두 번 평가하면 비교할 수 있어요."
        />
      ) : (
        <Card className="p-4">
          <ComparePicker options={options} baseline={baseline} candidate={candidate} />
        </Card>
      )}

      {error && <Callout tone="danger">비교하지 못했어요: {error}</Callout>}

      {diff && (
        <div className="space-y-7">
          <section className="space-y-2.5">
            <SectionHeader title="메트릭 변화" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <SideRef
                workspace={workspace}
                label="baseline"
                id={diff.baseline}
                model={baselineModel}
              />
              <span className="text-faint">→</span>
              <SideRef
                workspace={workspace}
                label="candidate"
                id={diff.candidate}
                model={candidateModel}
              />
            </div>
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
                      className={cn(
                        'text-right font-mono text-[12px] tabular-nums',
                        m.delta === 0
                          ? 'text-muted-foreground'
                          : m.delta > 0
                            ? 'font-[510] text-[var(--color-success)]'
                            : 'font-[510] text-destructive'
                      )}
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
              title="나빠진 케이스 (통과→실패)"
              tone="danger"
              items={diff.regressions}
              empty="나빠진 케이스가 없어요."
            />
            <DeltaList
              title="좋아진 케이스 (실패→통과)"
              tone="success"
              items={diff.improvements}
              empty="좋아진 케이스가 없어요."
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
  // 변화 폭이 큰 케이스부터 — 눈에 띄는 회귀/개선을 위로.
  const sorted = [...items].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  return (
    <Card className="space-y-2.5 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-[560]">{title}</h2>
        <Badge tone={tone}>{items.length}</Badge>
      </div>
      {sorted.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {sorted.map((d) => (
            <li
              key={`${d.caseId}:${d.metric}`}
              className="flex items-center justify-between gap-2 py-1.5 first:pt-0 last:pb-0"
            >
              <span className="min-w-0 truncate font-mono text-[12px]">
                {d.caseId}
                <span className="text-faint"> · {d.metric}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 font-mono text-[12px] tabular-nums">
                <span className="text-muted-foreground">
                  {d.baseline} → {d.candidate}
                </span>
                <span
                  className={cn(
                    'font-[510]',
                    tone === 'danger' ? 'text-destructive' : 'text-[var(--color-success)]'
                  )}
                >
                  {delta(d.delta)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
