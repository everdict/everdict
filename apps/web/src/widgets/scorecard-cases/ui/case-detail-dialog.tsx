'use client'

import { useEffect, useState, useTransition } from 'react'
import { ChevronLeft, ChevronRight, Download, ExternalLink, Timer, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  asSingleSegment,
  getTrajectoryAction,
  TrajectoryView,
  type TrajectorySegment,
} from '@/features/browse-traces'
import {
  classifyMetric,
  classifyScoreDetail,
  fmtMetricValue,
  groupMetricRows,
  isUnmeasuredScore,
} from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EnvBadge, GraderBadge } from '@/shared/ui/case-badges'
import { CopyLinkButton } from '@/shared/ui/copy-link-button'
import { Dialog } from '@/shared/ui/dialog'
import { ExpandableText } from '@/shared/ui/expandable-text'
import { Link } from '@/shared/ui/link'
import { Markdown } from '@/shared/ui/markdown'
import { MetricLabel } from '@/shared/ui/metric-label'
import { ScoreDetail } from '@/shared/ui/score-detail'

import { getScorecardCaseTraceAction } from '../api/case-trace'
import type { CaseScoreView, ScorecardCaseView } from '../model/case-view'

// 케이스 상세 다이얼로그 — 분석하는 사람의 세 질문에 위에서 아래로 답한다:
// ① 어떤 케이스였나(데이터셋 과제) → ② 실제로 어떻게 실행됐나(에이전트 궤적 + 스냅샷/에러) →
// ③ 어떻게 평가됐나(판정 근거 + 저지/그레이더 점수와 리즈닝). 궤적은 봉인 증거의 단일 읽기 표면인
// TrajectoryView 로 연다(자식 run → 궤적 원장, 없으면 임베디드 케이스 트레이스). 헤더·메타·prev/next·←/→ 는
// TrajectoryDetailDialog 와 같은 문법.
export function CaseDetailDialog({
  workspace,
  scorecardId,
  item: c,
  onClose,
  nav,
}: {
  workspace: string
  scorecardId: string
  item: ScorecardCaseView
  onClose: () => void
  nav: { index: number; total: number; onPrev: () => void; onNext: () => void }
}) {
  const t = useTranslations('scorecardsPage')
  const [segments, setSegments] = useState<TrajectorySegment[] | undefined>()
  const [traceError, setTraceError] = useState<string | undefined>()
  const [pending, start] = useTransition()

  // 실행 증거는 열릴 때 그 케이스 것만 가져온다 — 자식 run 이 있으면 궤적 원장(다중 평면), 없으면
  // 스코어카드에 임베디드된 케이스 트레이스(단일 평면). 목록 직렬화에 전 케이스 트레이스를 싣지 않는 이유.
  useEffect(() => {
    setSegments(undefined)
    setTraceError(undefined)
    if (c.runId === undefined && !c.hasTrace) return
    const runId = c.runId
    start(async () => {
      if (runId !== undefined) {
        const res = await getTrajectoryAction(runId)
        if (res.ok) setSegments(res.segments)
        else setTraceError(res.error)
      } else {
        const res = await getScorecardCaseTraceAction(scorecardId, c.caseId, c.occurrence)
        if (res.ok) setSegments(res.events.length > 0 ? asSingleSegment(res.events, 'run') : [])
        else setTraceError(res.error)
      }
    })
  }, [scorecardId, c.key, c.caseId, c.occurrence, c.runId, c.hasTrace])

  // ←/→ 로 형제 케이스 이동 (궤적/외부 트레이스 상세와 동일한 조작).
  const hasPrev = nav.index > 0
  const hasNext = nav.index < nav.total - 1
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft' && hasPrev) nav.onPrev()
      if (e.key === 'ArrowRight' && hasNext) nav.onNext()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [nav, hasPrev, hasNext])

  const caseMetrics = c.scores.map((s) => s.metric)
  const scoreGroups = groupMetricRows(c.scores)
  const hasTrajectory = c.runId !== undefined || c.hasTrace
  const hasExecution =
    hasTrajectory || c.snapshot !== undefined || c.errors.length > 0 || c.runnerHint !== undefined
  const hasIdentity =
    c.task !== undefined || c.envKind !== undefined || (c.graderIds?.length ?? 0) > 0

  return (
    <Dialog
      open
      onClose={onClose}
      labelledBy="scorecard-case-dialog-title"
      className="flex h-[92vh] max-h-[92vh] max-w-[1200px] flex-col"
    >
      {/* 좁은 화면에선 액션 묶음이 제목 아래로 줄바꿈된다 — 다이얼로그 폭이 좁아도 헤더가 넘치지 않게. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge tone={c.verdict == null ? 'neutral' : c.verdict ? 'success' : 'danger'}>
            {c.verdict == null ? 'SKIP' : c.verdict ? 'PASS' : 'FAIL'}
          </Badge>
          <h2
            id="scorecard-case-dialog-title"
            className="truncate font-mono text-[15px] font-[600]"
          >
            {c.caseId}
          </h2>
          {/* 트라이얼 배치 — 같은 caseId 가 여러 행이므로 어느 트라이얼을 보고 있는지 헤더가 밝힌다. */}
          {c.trial !== undefined && (
            <Badge tone="neutral">{t('caseTrialBadge', { n: c.trial })}</Badge>
          )}
          {c.snapshot?.kind && <Badge tone="neutral">{c.snapshot.kind}</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* 이 케이스의 자식 run — 전체 실행 상세(사용량·출처·라이브 채널)로 가는 문. */}
          {c.runId !== undefined && (
            <Link
              href={`/${workspace}/run/${encodeURIComponent(c.runId)}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <ExternalLink className="size-4" />
              {t('caseOpenRun')}
            </Link>
          )}
          {/* 트레이스 싱크 딥링크 — 관측 플랫폼의 원본/내보낸 트레이스. */}
          {c.exportUrl !== undefined && (
            <a
              href={c.exportUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {c.sinkKind ?? 'trace'} ↗
            </a>
          )}
          {/* 열림 상태가 ?case= 로 URL 에 미러링되므로, 지금 주소가 곧 이 케이스의 공유 링크다. */}
          <CopyLinkButton
            label={t('caseCopyLink')}
            message={t('caseLinkCopied')}
            className="rounded-md border border-border p-1.5 text-muted-foreground"
          />
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={nav.onPrev}
              disabled={!hasPrev}
              aria-label={t('casePrev')}
              className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35 disabled:hover:text-muted-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-12 text-center font-mono text-[11px] tabular-nums text-faint">
              {nav.index + 1} / {nav.total}
            </span>
            <button
              type="button"
              onClick={nav.onNext}
              disabled={!hasNext}
              aria-label={t('caseNext')}
              className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35 disabled:hover:text-muted-foreground"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('caseClose')}
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
        {/* ① 어떤 케이스였나 — 데이터셋 케이스 정의 (과제 본문 + 환경/채점/태그 메타). */}
        {hasIdentity && (
          <section className="space-y-2">
            <SectionLabel>{t('caseDialogTask')}</SectionLabel>
            <div className="flex flex-wrap items-center gap-1.5">
              {c.envKind && <EnvBadge kind={c.envKind} />}
              {(c.graderIds ?? []).map((g, i) => (
                <GraderBadge key={`${g}-${i}`} id={g} />
              ))}
              {typeof c.timeoutSec === 'number' && (
                <span className="inline-flex items-center gap-1 text-[11px] text-faint">
                  <Timer className="size-3" />
                  {c.timeoutSec}s
                </span>
              )}
              {(c.tags ?? []).map((tag) => (
                <span key={tag} className="text-[10.5px] text-faint">
                  #{tag}
                </span>
              ))}
            </div>
            {c.task && (
              <div className="rounded-lg border border-border bg-card p-3.5">
                <Markdown content={c.task} />
              </div>
            )}
          </section>
        )}

        {/* ② 실제로 어떻게 실행됐나 — 에이전트 궤적 + 실행이 남긴 것(스크린샷·최종 URL·DOM·에러·러너 힌트). */}
        {hasExecution && (
          <section className="space-y-2.5">
            <SectionLabel>{t('caseDialogExecution')}</SectionLabel>
            {traceError !== undefined ? (
              <Callout tone="danger">{t('caseTraceError', { error: traceError })}</Callout>
            ) : pending && segments === undefined ? (
              <p className="px-1 py-2 text-[12px] text-faint">{t('caseTraceLoading')}</p>
            ) : segments !== undefined && segments.length > 0 ? (
              // TrajectoryView 는 호스트가 확정 높이를 줘야 한다 — run 상세의 증거 섹션과 같은 규칙.
              <div className="h-[46vh] min-h-[320px] rounded-lg border border-border bg-card p-3">
                <TrajectoryView segments={segments} />
              </div>
            ) : hasTrajectory ? (
              <p className="text-[12px] text-muted-foreground">{t('caseTraceEmpty')}</p>
            ) : null}
            {/* os-use 스크린샷 — VLM 이 채점한 바로 그 화면. */}
            {c.snapshot?.screenshotSrc && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={c.snapshot.screenshotSrc}
                alt={`${c.caseId} screenshot`}
                className="max-h-80 w-auto rounded-lg border"
              />
            )}
            {/* browser — 에이전트가 도달한 최종 URL (+ 오프로드된 전체 DOM 다운로드). */}
            {c.snapshot?.url && (
              <p className="break-all font-mono text-[12px] text-muted-foreground">
                <span className="font-[510] text-foreground">final url</span> · {c.snapshot.url}
              </p>
            )}
            {c.snapshot?.domRef && (
              <a
                href={c.snapshot.domRef}
                target="_blank"
                rel="noreferrer"
                download
                className="inline-flex items-center gap-1.5 text-[12px] font-[510] text-link transition-colors hover:text-foreground"
              >
                <Download className="size-3.5" />
                {t('downloadDom')}
              </a>
            )}
            {/* 케이스가 어떻게 죽었나 — 트레이스의 error 이벤트 (하네스 크래시/디스패치 에러). */}
            {c.errors.map((message, i) => (
              <div
                key={`case-error-${i}`}
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-[12px] leading-relaxed text-destructive"
              >
                <ExpandableText
                  text={message}
                  prefix={
                    <>
                      <span className="font-[560]">error</span> ·{' '}
                    </>
                  }
                  className="whitespace-pre-wrap break-words"
                />
              </div>
            ))}
            {/* self-hosted 러너 실패 힌트 — 서버가 로스터를 읽어 로컬라이즈까지 끝낸 문장. */}
            {c.runnerHint && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-700 dark:text-amber-400">
                {c.runnerHint}
              </p>
            )}
          </section>
        )}

        {/* ③ 어떻게 평가됐나 — 판정 근거(어느 권위 층이 결정했나) + 점수 행(리즈닝 펼침, 실패 행은 기본 펼침). */}
        <section className="space-y-2.5">
          <SectionLabel>{t('caseDialogEvaluation')}</SectionLabel>
          {(c.verdict !== undefined || c.verdictBasis !== undefined) && (
            <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 shadow-raise">
              {c.verdict !== undefined && (
                <Badge tone={c.verdict ? 'success' : 'danger'}>{c.verdict ? 'PASS' : 'FAIL'}</Badge>
              )}
              {c.verdictBasis && (
                <>
                  <span className="text-[12.5px] text-muted-foreground">
                    {t('caseDecidedBy', {
                      authority: c.verdictBasis.authority,
                      aggregation: c.verdictBasis.aggregation,
                    })}
                  </span>
                  {c.verdictBasis.deciders.map((d) => (
                    <Badge
                      key={`${d.graderId}:${d.metric}`}
                      title={d.graderId}
                      tone={d.pass ? 'success' : 'danger'}
                    >
                      {d.metric} {d.pass ? '✓' : '✗'}
                    </Badge>
                  ))}
                </>
              )}
            </div>
          )}
          {c.scores.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">{t('noScores')}</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              {scoreGroups.map((group) => (
                <div key={`${group.row.graderId}:${group.row.metric}`}>
                  <ScoreRow score={group.row} siblings={caseMetrics} />
                  {group.criteria.map((criterion) => (
                    <ScoreRow
                      key={criterion.row.metric}
                      score={criterion.row}
                      siblings={caseMetrics}
                      nested
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Dialog>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">{children}</p>
}

// 한 점수의 값 — categorical `label` 은 그대로(gold / correct / B), 아니면 단위 추론 포맷. 판정 배지가
// 따로 서 있으므로 run 상세의 값 칸처럼 0/1 도 실제 값으로 보여준다.
function displayValue(s: CaseScoreView): string {
  if (s.label !== undefined && s.label !== '') return s.label
  return fmtMetricValue(classifyMetric({ metric: s.metric, mean: s.value }), s.value)
}

// 한 지표 행 — run 상세 EvalOutcome 의 행 문법과 동일: detail(판정 근거)이 있으면 펼칠 수 있고, 실패한
// 행은 기본으로 펼쳐진다. "왜 실패했나"가 가장 깊은 곳에 접혀 있던 게 이전 케이스 카드의 핵심 문제였다.
function ScoreRow({
  score,
  siblings,
  nested,
}: {
  score: CaseScoreView
  siblings: string[]
  nested?: boolean
}) {
  const t = useTranslations('scorecardsPage')
  const hasDetail = classifyScoreDetail(score.detail) !== undefined
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
        {unmeasured ? t('scoreUnmeasured') : displayValue(score)}
      </span>
      <span className="w-12 text-right">
        {score.pass != null && !unmeasured && (
          <Badge tone={score.pass ? 'success' : 'danger'}>{score.pass ? 'pass' : 'fail'}</Badge>
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
