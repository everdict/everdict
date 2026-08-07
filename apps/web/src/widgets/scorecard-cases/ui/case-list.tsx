'use client'

import { ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  fmtMetricLabel,
  groupMetricRows,
  isUnmeasuredScore,
  scoreBadgeValue,
  scoreTone,
} from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'

import type { ScorecardCaseView } from '../model/case-view'
import { useScorecardCases } from './case-dialog-context'

// 케이스 목록 — 한 케이스가 한 줄로 읽히는 컴팩트 행. 판정 배지 · 케이스 id · 과제 한 줄 · overall 점수
// 배지까지만 싣고, 나머지(스크린샷·근거·에러·criterion)는 전부 클릭해 여는 상세 다이얼로그의 것이다.
// 이전의 카드 그리드가 모든 케이스의 모든 근거를 목록에 펼쳐 화면을 압도하던 것의 교체.
export function ScorecardCaseList() {
  const { cases, openCase } = useScorecardCases()
  return (
    <div className="space-y-1.5">
      {cases.map((c) => (
        <CaseRow key={c.key} item={c} onOpen={() => openCase(c.key)} />
      ))}
    </div>
  )
}

function CaseRow({ item: c, onOpen }: { item: ScorecardCaseView; onOpen: () => void }) {
  const t = useTranslations('scorecardsPage')
  const caseMetrics = c.scores.map((s) => s.metric)
  // criterion 은 다이얼로그에서 — 목록 행은 overall(그룹 대표) 배지만 세운다.
  const overallScores = groupMetricRows(c.scores).map((g) => g.row)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-lg border border-l-2 bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        c.verdict === false
          ? 'border-l-destructive'
          : c.verdict == null
            ? 'border-l-border-strong'
            : 'border-l-[var(--color-success)]/60'
      )}
    >
      <Badge tone={c.verdict == null ? 'neutral' : c.verdict ? 'success' : 'danger'}>
        {c.verdict == null ? 'SKIP' : c.verdict ? 'PASS' : 'FAIL'}
      </Badge>
      <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
        <span className="shrink-0 font-mono text-[13px] font-[510]">{c.caseId}</span>
        {/* 트라이얼 배치 — 같은 케이스의 몇 번째 실행인지 없으면 행들이 구분 불가능한 쌍둥이로 보인다. */}
        {c.trial !== undefined && (
          <span className="shrink-0 font-mono text-[11px] text-faint">
            {t('caseTrialBadge', { n: c.trial })}
          </span>
        )}
        {/* 케이스의 정체 한 줄 — 분석하는 사람이 목록에서도 "무슨 케이스인지" 바로 읽도록. */}
        {c.task && (
          <span className="min-w-0 truncate text-[12px] text-muted-foreground">{c.task}</span>
        )}
      </span>
      {/* shrink-0 금지 — 배지가 많은(다중 저지) 케이스가 좁은 컬럼에서 행 밖으로 밀려나지 않고 줄바꿈된다. */}
      <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
        {c.scores.length === 0 ? (
          <span className="text-[12px] text-muted-foreground">{t('noScores')}</span>
        ) : (
          overallScores.map((s) => (
            <Badge key={`${s.graderId}:${s.metric}`} title={s.metric} tone={scoreTone(s)}>
              {fmtMetricLabel(s.metric, caseMetrics)}{' '}
              {isUnmeasuredScore(s) ? t('scoreUnmeasured') : scoreBadgeValue(s)}
            </Badge>
          ))
        )}
        <ChevronRight className="size-3.5 text-faint" />
      </span>
    </div>
  )
}
