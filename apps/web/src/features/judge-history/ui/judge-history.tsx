'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'

import type { ScorecardStatus } from '@/entities/scorecard'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { EntityRef, MetricChip } from '@/shared/ui/chip'
import { StatusIcon } from '@/shared/ui/status-pill'

// 한 페이지에 노출할 개수 — 초기 대량 렌더를 막고 "더보기"로 10개씩 점진 노출.
const PAGE_SIZE = 10

// 평가 이력 한 행에 필요한 최소 데이터(서버에서 조립해 전달 — 직렬화 가능한 평면 형태).
export interface JudgeHistoryEntry {
  id: string
  dataset: { id: string; version?: string }
  harness: { id: string; version?: string }
  // 이 저지의 메트릭만(overall + 기준) — 칩은 compact 형(저지 id 생략)으로 렌더.
  metrics: { metric: string; mean: number; passRate?: number | null }[]
  runner?: { name: string; avatarUrl?: string }
  createdAt: string
  status: ScorecardStatus
}

// 저지 상세의 평가 이력 리스트.
// - 페이지네이션: 10개만 보이고 "더보기"로 이어서 노출.
// - 레이아웃 우선순위: 데이터셋·하네스는 축소되지 않고(우선 폭), judge 메트릭 칩이 먼저 축약/클립된다.
export function JudgeHistory({
  workspace,
  entries,
  timeZone,
}: {
  workspace: string
  entries: JudgeHistoryEntry[]
  timeZone: string
}) {
  const t = useTranslations('judgesPage')
  const [visible, setVisible] = useState(PAGE_SIZE)
  const shown = entries.slice(0, visible)
  const remaining = entries.length - shown.length

  return (
    <div className="space-y-2">
      {shown.map((s) => {
        const siblings = s.metrics.map((m) => m.metric)
        return (
          <Link
            key={s.id}
            href={`/${workspace}/scorecards/${encodeURIComponent(s.id)}`}
            className="group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
          >
            {/* 데이터셋 · 하네스 — 우선 폭(내용 폭 유지). flex-basis 0 이라 여백을 흡수하고, 극단적으로 긴 id 에서만 truncate. */}
            <div className="flex min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap text-[13px] font-[510]">
              <span className="truncate">
                <EntityRef id={s.dataset.id} version={s.dataset.version} kind="dataset" />
              </span>
              <span className="shrink-0 text-faint">·</span>
              <span className="truncate">
                <EntityRef id={s.harness.id} version={s.harness.version} kind="harness" />
              </span>
            </div>
            {/* judge 메트릭 — 저지 페이지에선 'judge <id>' 가 중복이라 compact 로 축약. 공간이 부족하면
                (shrink + overflow-hidden) 데이터셋·하네스보다 먼저 이 칼럼이 클립된다. */}
            <div className="hidden min-w-0 shrink items-center justify-end gap-1 overflow-hidden sm:flex">
              {s.metrics.slice(0, 2).map((m) => (
                <span key={m.metric} className="shrink-0">
                  <MetricChip
                    metric={m.metric}
                    mean={m.mean}
                    passRate={m.passRate}
                    siblings={siblings}
                    compact
                  />
                </span>
              ))}
              {s.metrics.length > 2 && (
                <span className="shrink-0 text-[11px] text-faint">+{s.metrics.length - 2}</span>
              )}
            </div>
            {/* 실행자 · 시각 · 상태 — 고정 폭 */}
            <div className="flex shrink-0 items-center gap-2.5">
              <span className="flex w-6 justify-center">
                {s.runner && (
                  <UserAvatar
                    name={s.runner.name}
                    url={s.runner.avatarUrl}
                    label={t('evaluationHistoryRunner')}
                  />
                )}
              </span>
              <time
                className="hidden w-[84px] text-right font-mono text-[11px] text-muted-foreground sm:block"
                title={fmtDateTimeFull(s.createdAt, { timeZone })}
              >
                {fmtDateTime(s.createdAt, timeZone)}
              </time>
              <span className="flex w-5 justify-end">
                <StatusIcon status={s.status} />
              </span>
            </div>
          </Link>
        )
      })}
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
          className="w-full rounded-lg border border-dashed border-border px-3.5 py-2 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:bg-elevated hover:text-foreground"
        >
          {t('evaluationHistoryLoadMore', { count: remaining })}
        </button>
      )}
    </div>
  )
}
