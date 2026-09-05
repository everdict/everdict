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

// The result slot — the one place on a run detail that is swapped per kind. Once the ledger became five families, "a score" stopped being a
// universal result and became an EVAL's result: an agent turn will never have one (the conversation IS the result), and a sandbox session's
// result is what it stood up and when it was reclaimed. So the skeleton (identity, economics, live, evidence, artifacts) is shared and only this slot branches.
// With nothing to show, the section itself is not rendered (no empty sections — docs/web.md).

type OutcomeRun = Pick<
  Run,
  'kind' | 'status' | 'caseId' | 'verdict' | 'result' | 'session' | 'group'
>

// The value cell — unlike the scorecard's chip (which folds 0/1 into ✓/✗), the verdict cell stands separately here, so the REAL value is always shown.
// Unit inference is done by the shared atom (cost $ / latency s / ratio % / count).
function displayValue(score: Score): string {
  // For a categorical metric the label IS the value to read (`value` is demoted to a sort key) — the same rule as its twin on the scorecard case detail.
  if (score.label !== undefined && score.label !== '') return score.label
  // Unmeasured rows are filtered out before this is called (isUnmeasuredScore) — a dash is still the honest mark when there is no value.
  if (score.value === undefined) return '–'
  return fmtMetricValue(classifyMetric({ metric: score.metric, mean: score.value }), score.value)
}

function passTone(pass?: boolean): 'neutral' | 'success' | 'danger' {
  return pass == null ? 'neutral' : pass ? 'success' : 'danger'
}

// One metric row. It expands when there is a `detail` (the grounds for the verdict), and a FAILING row is expanded by default — "why did it
// fail" being folded away deepest was the previous card grid's central problem.
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

// eval — a one-line verdict plus the metric table. The verdict is computed by the server on the authority ranking and carried on the read (the
// client NEVER recomputes it); the "n/m passed" beside it is only COUNTING, so it is made here. A judge's criteria are indented under their
// own overall row (groupMetricRows).
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

// agent — an activation's result is the conversation itself. Jumping to the conversation this turn belongs to is the only meaningful next
// action, and what woke it (caseId = an eventId or eventKind, or "chat") stands beside it.
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

// sandbox — a session's result is "what it stood up, how long it lives, and why it ended". A bare `succeeded` cannot separate a clean exit from
// TTL expiry and orphan reclamation are indistinguishable, so the END REASON is shown verbatim (reclamation IS a session's normal completion).
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
  // No kind set = an eval run from before this field (readers treat undefined as "eval" — the contract's rule).
  switch (run.kind) {
    case 'agent':
      return <AgentOutcome run={run} action={action} />
    case 'sandbox':
      return <SessionOutcome run={run} />
    default:
      return <EvalOutcome run={run} />
  }
}
