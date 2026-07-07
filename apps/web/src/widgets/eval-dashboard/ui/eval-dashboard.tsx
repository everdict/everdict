import Link from 'next/link'
import { ChevronRight, FlaskConical } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { MetricSummary, ScorecardRecord } from '@/entities/scorecard'
import { fmtDateTime, fmtPct } from '@/shared/lib/format'
import { EntityRef, ModelChip } from '@/shared/ui/chip'
import { EmptyState } from '@/shared/ui/empty-state'
import { Score } from '@/shared/ui/score'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatCard } from '@/shared/ui/stat-card'
import { StatusPill } from '@/shared/ui/status-pill'

// 대표 메트릭 — 통과율이 있는 첫 메트릭, 없으면 첫 메트릭. 벤치마크 점수의 기준.
function primary(s: ScorecardRecord): MetricSummary | undefined {
  return s.summary?.find((m) => m.passRate != null) ?? s.summary?.[0]
}
function scoreOf(s: ScorecardRecord): number {
  const m = primary(s)
  return m?.passRate ?? m?.mean ?? -1
}

// 순위 메달 — 1위 금·2위 은·3위 동(리더보드와 동일 인코딩).
function Rank({ rank }: { rank: number }) {
  const base =
    'inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-[560] tabular-nums ring-1 ring-inset'
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
  return (
    <span className="grid size-5 shrink-0 place-items-center font-mono text-[11px] tabular-nums text-faint">
      {rank}
    </span>
  )
}

// 평가 대시보드 — 배치 스코어카드(벤치마크 × 하니스)를 개요 루트에 요약. 상단 지표 + 벤치마크별 리더보드.
export function EvalDashboard({
  scorecards,
  workspace,
}: {
  scorecards: ScorecardRecord[]
  workspace: string
}) {
  const t = useTranslations('evalDashboard')
  const done = scorecards.filter((s) => s.status === 'succeeded')
  const benchmarks = new Set(scorecards.map((s) => s.dataset.id))
  const harnesses = new Set(scorecards.map((s) => s.harness.id))
  const rates = done.map((s) => primary(s)?.passRate).filter((r): r is number => r != null)
  const avgPass = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null

  const viewAll = (
    <Link
      href={`/${workspace}/scorecards`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      {t('viewAll')}
      <ChevronRight className="size-3.5" />
    </Link>
  )

  if (scorecards.length === 0) {
    return (
      <section className="space-y-2.5">
        <SectionHeader title={t('title')} />
        <EmptyState icon={<FlaskConical />} title={t('emptyTitle')} hint={t('emptyHint')} />
      </section>
    )
  }

  // 벤치마크(데이터셋 id)별 그룹 — 케이스 많은 순, 각 그룹은 점수 내림차순.
  const groups = new Map<string, ScorecardRecord[]>()
  for (const s of scorecards) {
    const arr = groups.get(s.dataset.id) ?? []
    arr.push(s)
    groups.set(s.dataset.id, arr)
  }
  const benchList = [...groups.entries()]
    .map(([id, runs]) => ({
      id,
      runs: [...runs].sort((a, b) => scoreOf(b) - scoreOf(a)),
      cases: Math.max(...runs.map((r) => primary(r)?.count ?? 0)),
    }))
    .sort((a, b) => b.cases - a.cases)
    .slice(0, 4)

  return (
    <section className="space-y-3">
      <SectionHeader title={t('title')} action={viewAll} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t('statRuns')} value={scorecards.length} />
        <StatCard label={t('statBenchmarks')} value={benchmarks.size} />
        <StatCard label={t('statHarnesses')} value={harnesses.size} />
        <StatCard
          label={t('statAvgPass')}
          value={avgPass != null ? fmtPct(avgPass) : '–'}
          tone="primary"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {benchList.map((b) => (
          <div key={b.id} className="rounded-lg border bg-card p-3.5 shadow-raise">
            <div className="mb-2 flex items-center gap-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border">
                <FlaskConical className="size-4" strokeWidth={1.75} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-[560] text-foreground">
                <EntityRef id={b.id} kind="dataset" />
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-faint">
                {t('benchMeta', { cases: b.cases, runs: b.runs.length })}
              </span>
            </div>
            <ul className="divide-y divide-border/60">
              {b.runs.slice(0, 4).map((s, i) => (
                <li key={s.id}>
                  <Link
                    href={`/${workspace}/scorecards/${s.id}`}
                    className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-elevated"
                  >
                    <Rank rank={i + 1} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
                      <EntityRef id={s.harness.id} version={s.harness.version} kind="harness" />
                    </span>
                    {s.models?.primary ? <ModelChip muted>{s.models.primary}</ModelChip> : null}
                    <span className="shrink-0 text-[10.5px] tabular-nums text-faint">
                      {fmtDateTime(s.createdAt)}
                    </span>
                    {s.status === 'succeeded' ? (
                      <Score passRate={primary(s)?.passRate} mean={primary(s)?.mean} />
                    ) : (
                      <StatusPill status={s.status} />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
