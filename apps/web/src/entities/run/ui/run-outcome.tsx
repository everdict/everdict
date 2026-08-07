'use client'

import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTimeZone, useTranslations } from 'next-intl'

import {
  classifyMetric,
  classifyScoreDetail,
  fmtDateTime,
  fmtMetricValue,
  groupMetricRows,
  isUnmeasuredScore,
} from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { MetricLabel } from '@/shared/ui/metric-label'
import { ScoreDetail } from '@/shared/ui/score-detail'
import { SectionHeader } from '@/shared/ui/section-header'

import type { Run, Score } from '../model/schema'

// 결과 슬롯 — run 상세에서 kind 마다 갈아끼우는 단 하나의 자리. 원장이 5-패밀리가 되면서 "점수"는 eval 의
// 결과일 뿐 보편 결과가 아니게 됐다: 에이전트 턴에는 점수가 영원히 없고(대화가 결과), 샌드박스 세션의 결과는
// 무엇을 띄웠고 언제 회수됐는가다. 그래서 골격(정체성·경제·라이브·증거·산출물)은 공유하고 이 슬롯만 분기한다.
// 보여줄 게 없으면 섹션 자체를 렌더하지 않는다(빈 섹션 금지 — docs/web.md).

type OutcomeRun = Pick<
  Run,
  'kind' | 'status' | 'caseId' | 'verdict' | 'result' | 'session' | 'group'
>

// 값 칸 — 스코어카드의 칩(0/1 을 ✓/✗ 로 접는)과 달리 판정 칸이 따로 서 있으므로 언제나 실제 값을 보여준다.
// 단위 추론은 공용 아톰이 한다(비용 $ / 지연 s / 비율 % / 개수).
function displayValue(score: Score): string {
  // 측정이 아닌 행은 호출 전에 걸러진다(isUnmeasuredScore) — 그래도 값이 없으면 대시가 정직한 표시다.
  if (score.value === undefined) return '–'
  return fmtMetricValue(classifyMetric({ metric: score.metric, mean: score.value }), score.value)
}

function passTone(pass?: boolean): 'neutral' | 'success' | 'danger' {
  return pass == null ? 'neutral' : pass ? 'success' : 'danger'
}

// 한 지표 행. detail(판정 근거)이 있으면 펼칠 수 있고, 실패한 행은 기본으로 펼쳐진다 — "왜 실패했나"가
// 가장 깊은 곳에 접혀 있던 게 이전 카드 그리드의 핵심 문제였다.
function ScoreRow({
  score,
  siblings,
  nested,
}: {
  score: Score
  siblings: string[]
  nested?: boolean
}) {
  const tScores = useTranslations('runsPage')
  const hasDetail = classifyScoreDetail(score.detail) !== undefined
  // A non-measurement (grader error / judge skip) shows "unmeasured" instead of its placeholder value —
  // a dead grader must never read as a real $0.00 / 0-step result.
  const unmeasured = isUnmeasuredScore(score)
  const [open, setOpen] = useState(score.pass === false && hasDetail)
  const body = (
    <div
      className={cn(
        'grid w-full items-center gap-3 px-3 py-2 text-left [grid-template-columns:minmax(0,1fr)_auto_auto]',
        hasDetail && 'transition-colors hover:bg-elevated/50'
      )}
    >
      <span className={cn('flex min-w-0 items-center gap-2', nested && 'pl-5')}>
        {hasDetail && (
          <ChevronRight
            className={cn('size-3.5 shrink-0 text-faint transition-transform', open && 'rotate-90')}
          />
        )}
        <span className="min-w-0 truncate font-mono text-[11px] text-faint">{score.graderId}</span>
        <MetricLabel metric={score.metric} siblings={siblings} />
      </span>
      <span className="font-mono text-[13px] font-[510] tabular-nums">
        {unmeasured ? tScores('scoreUnmeasured') : displayValue(score)}
      </span>
      <span className="w-12 text-right">
        {score.pass != null && (
          <Badge tone={passTone(score.pass)}>{score.pass ? 'pass' : 'fail'}</Badge>
        )}
      </span>
    </div>
  )
  return (
    <div className="border-b border-border/60 last:border-b-0">
      {hasDetail ? (
        <button type="button" onClick={() => setOpen((v) => !v)} className="block w-full">
          {body}
        </button>
      ) : (
        body
      )}
      {open && <ScoreDetail detail={score.detail} className="mx-3 mb-3" />}
    </div>
  )
}

// eval — 판정 한 줄 + 지표 표. 판정(verdict)은 서버가 권위 순위로 계산해 실어 보낸 값이고(클라이언트는 절대
// 재계산하지 않는다), 옆의 "n/m 통과"는 세는 것일 뿐이라 여기서 만든다. 저지의 criterion 은 자기 overall 행
// 밑으로 들여쓰여 붙는다(groupMetricRows).
function EvalOutcome({ run }: { run: OutcomeRun }) {
  const t = useTranslations('runsPage')
  const scores = run.result?.scores ?? []
  if (scores.length === 0) return null

  const siblings = scores.map((s) => s.metric)
  // Measurements only — an unmeasured row smuggling a pass flag must not enter the "n/m graders passed" line.
  const decided = scores.filter((s) => s.pass !== undefined && !isUnmeasuredScore(s))
  const passed = decided.filter((s) => s.pass === true)

  return (
    <section className="space-y-2.5">
      <SectionHeader title={t('scores')} />
      {run.verdict !== undefined && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 shadow-raise">
          <Badge tone={run.verdict ? 'success' : 'danger'}>{run.verdict ? 'PASS' : 'FAIL'}</Badge>
          {decided.length > 0 && (
            <span className="text-[12.5px] text-muted-foreground">
              {t('verdictGraders', { passed: passed.length, total: decided.length })}
            </span>
          )}
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {groupMetricRows(scores).map((group) => (
          <div key={`${group.row.graderId}:${group.row.metric}`}>
            <ScoreRow score={group.row} siblings={siblings} />
            {group.criteria.map((criterion) => (
              <ScoreRow
                key={criterion.row.metric}
                score={criterion.row}
                siblings={siblings}
                nested
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}

// agent — 활성화의 결과는 대화 그 자체다. 이 턴이 속한 대화로 건너가는 것이 유일하게 의미 있는 다음 행동이고,
// 무슨 일로 깨어났는지(caseId = eventId 또는 eventKind, 챗이면 "chat")가 그 옆에 선다.
function AgentOutcome({ run, action }: { run: OutcomeRun; action?: ReactNode }) {
  const t = useTranslations('runsPage')
  const isChat = run.caseId === 'chat'
  if (!run.group && !action) return null
  return (
    <section className="space-y-2.5">
      <SectionHeader title={t('outcomeAgent')} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-3 py-2.5 shadow-raise">
        <span className="text-[12.5px] text-muted-foreground">
          {isChat ? t('agentTurnChat') : t('agentTurnCause', { cause: run.caseId })}
        </span>
        {action}
      </div>
    </section>
  )
}

// sandbox — 세션의 결과는 "무엇을 띄웠고, 언제까지 살아 있고, 왜 끝났나"다. `succeeded` 하나로는 정상 종료와
// TTL 만료와 고아 회수가 구분되지 않으므로 종료 사유를 그대로 보여준다(회수는 세션의 정상 완료다).
function SessionOutcome({ run }: { run: OutcomeRun }) {
  const t = useTranslations('runsPage')
  const timeZone = useTimeZone()
  const session = run.session
  if (!session) return null
  const closed = session.closedReason
  return (
    <section className="space-y-2.5">
      <SectionHeader title={t('outcomeSession')} />
      <div className="flex flex-wrap items-center gap-x-7 gap-y-2 rounded-lg border border-border bg-card px-3 py-2.5 shadow-raise">
        <Fact label={t('sessionImage')} value={session.image} mono />
        <Fact label={t('sessionTtl')} value={`${Math.round(session.ttlSec / 60)}m`} />
        <Fact
          label={closed ? t('sessionEnded') : t('sessionExpires')}
          value={fmtDateTime(session.expiresAt, timeZone)}
        />
        {closed && <Badge tone="neutral">{t(`sessionReason_${closed}`)}</Badge>}
      </div>
    </section>
  )
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">{label}</div>
      <div className={cn('mt-0.5 truncate text-[13px]', mono && 'font-mono')}>{value}</div>
    </div>
  )
}

export function RunOutcome({ run, action }: { run: OutcomeRun; action?: ReactNode }) {
  // kind 미설정 = 이 필드 이전의 eval run (readers treat undefined as "eval" — 계약의 규칙).
  switch (run.kind) {
    case 'agent':
      return <AgentOutcome run={run} action={action} />
    case 'sandbox':
      return <SessionOutcome run={run} />
    default:
      return <EvalOutcome run={run} />
  }
}
