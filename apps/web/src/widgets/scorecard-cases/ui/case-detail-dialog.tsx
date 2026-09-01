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
import { Tooltip } from '@/shared/ui/tooltip'

import { getScorecardCaseAction } from '../api/case-detail'
import {
  findCaseEvidence,
  type CaseExecutionView,
  type CaseScoreEvidence,
  type CaseScoreView,
  type ScorecardCaseDetail,
  type ScorecardCaseView,
} from '../model/case-view'

// 케이스 상세 다이얼로그 — 분석하는 사람의 세 질문에 위에서 아래로 답한다:
// ① 어떤 케이스였나(데이터셋 과제) → ② 실제로 어떻게 실행됐나(에이전트 궤적 + 스냅샷/에러) →
// ③ 어떻게 평가됐나(판정 근거 + 저지/그레이더 점수와 리즈닝). 궤적은 봉인 증거의 단일 읽기 표면인
// TrajectoryView 로 연다(자식 run → 궤적 원장, 없으면 임베디드 케이스 트레이스). 헤더·메타·prev/next·←/→ 는
// TrajectoryDetailDialog 와 같은 문법.
//
// **The evidence arrives per case, on open.** The task body, each score's rationale, the full error text and
// the screenshot do not ride the list payload — on a batch of hundreds that WAS why the screen stalled. A row
// knows only whether they exist; the contents come through one server action here, the same door the trace
// already went through.
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
  // index < 0 = a case outside the current filter (opened from the timeline) — no sibling control is stood up.
  nav: { index: number; total: number; onPrev: () => void; onNext: () => void }
}) {
  const t = useTranslations('scorecardsPage')
  const [detail, setDetail] = useState<ScorecardCaseDetail | undefined>()
  const [segments, setSegments] = useState<TrajectorySegment[] | undefined>()
  const [traceError, setTraceError] = useState<string | undefined>()
  // How much of the trace this dialog holds, and how much the seal says there is.
  const [traceLoaded, setTraceLoaded] = useState(0)
  const [traceTotal, setTraceTotal] = useState(0)
  // The store's answer to "is there more, from where" — never counted against a total that sums other planes.
  const [traceNextAfter, setTraceNextAfter] = useState<number | undefined>()
  const [pending, start] = useTransition()

  // Execution evidence and score evidence are fetched for this one case on open: with a child run the
  // trajectory comes from the ledger (several planes); without one, the scorecard's embedded case trace
  // (a single plane) rides the same round trip as the evidence.
  useEffect(() => {
    setDetail(undefined)
    setSegments(undefined)
    setTraceError(undefined)
    const runId = c.runId
    const embedded = runId === undefined && c.hasTrace
    start(async () => {
      const res = await getScorecardCaseAction(scorecardId, c.caseId, c.occurrence, embedded)
      if (!res.ok) {
        setTraceError(res.error)
        return
      }
      setDetail(res.detail)
      if (embedded)
        setSegments(
          res.events !== undefined && res.events.length > 0
            ? asSingleSegment(res.events, 'run')
            : []
        )
      if (runId === undefined) return
      // A window, not the whole trace: a case can carry somebody else's long agent run, and the dialog
      // should open at the same speed whatever the run's length. `loadMoreTrace` fetches the rest.
      const trajectory = await getTrajectoryAction(runId)
      if (trajectory.ok) {
        setSegments(trajectory.segments)
        setTraceLoaded(trajectory.events.length)
        setTraceTotal(trajectory.total)
        setTraceNextAfter(trajectory.nextAfter)
      } else setTraceError(trajectory.error)
    })
  }, [scorecardId, c.key, c.caseId, c.occurrence, c.runId, c.hasTrace])

  // Append the next window of the case's trace onto the planes already drawn — same merge as the
  // observability dialog: a page belongs to whichever emitters it carried, and an absent emitter keeps what
  // it had rather than being reset.
  const loadMoreTrace = () => {
    const runId = c.runId
    if (runId === undefined) return
    start(async () => {
      const more = await getTrajectoryAction(runId, traceNextAfter ?? traceLoaded)
      if (!more.ok) {
        setTraceError(more.error)
        return
      }
      setSegments((held) => {
        if (!held) return more.segments
        const byEmitter = new Map(more.segments.map((seg) => [seg.emitter, seg]))
        const merged = held.map((seg) => {
          const extra = byEmitter.get(seg.emitter)
          byEmitter.delete(seg.emitter)
          return extra ? { ...seg, events: [...seg.events, ...extra.events] } : seg
        })
        return [...merged, ...byEmitter.values()]
      })
      setTraceLoaded((n) => n + more.events.length)
      setTraceNextAfter(more.nextAfter)
    })
  }

  // ←/→ 로 형제 케이스 이동 (궤적/외부 트레이스 상세와 동일한 조작).
  const navigable = nav.index >= 0
  const hasPrev = navigable && nav.index > 0
  const hasNext = navigable && nav.index < nav.total - 1
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
    hasTrajectory ||
    c.snapshot !== undefined ||
    c.hasScreenshot ||
    c.errorCount > 0 ||
    c.runnerHint !== undefined ||
    c.execution !== undefined
  const hasIdentity =
    c.taskSummary !== undefined || c.envKind !== undefined || (c.graderIds?.length ?? 0) > 0

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
          {navigable && (
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
          )}
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
            {/* The body arrives after opening — until it does, the one line the list already had holds the
                place (rather than a blank). */}
            {(detail?.task ?? c.taskSummary) !== undefined && (
              <div className="rounded-lg border border-border bg-card p-3.5">
                {detail?.task !== undefined ? (
                  <Markdown content={detail.task} />
                ) : (
                  <p className="text-[13px] text-muted-foreground">{c.taskSummary}</p>
                )}
              </div>
            )}
          </section>
        )}

        {/* ② 실제로 어떻게 실행됐나 — 에이전트 궤적 + 실행이 남긴 것(스크린샷·최종 URL·DOM·에러·러너 힌트). */}
        {hasExecution && (
          <section className="space-y-2.5">
            <SectionLabel>{t('caseDialogExecution')}</SectionLabel>
            {/* 어떤 세계에서 돌았나 — 궤적 위에 한 줄. 기록이 없으면 통째로 숨는다(빈 섹션 숨김 관습). */}
            {c.execution && <ExecutionStrip execution={c.execution} />}
            {traceError !== undefined ? (
              <Callout tone="danger">{t('caseTraceError', { error: traceError })}</Callout>
            ) : pending && segments === undefined ? (
              <p className="px-1 py-2 text-[12px] text-faint">{t('caseTraceLoading')}</p>
            ) : segments !== undefined && segments.length > 0 ? (
              // TrajectoryView 는 호스트가 확정 높이를 줘야 한다 — run 상세의 증거 섹션과 같은 규칙.
              <div className="h-[46vh] min-h-[320px] rounded-lg border border-border bg-card p-3">
                {traceNextAfter !== undefined && (
                  <p className="flex items-center gap-3 pb-2 text-[12px] text-faint">
                    <span>{t('caseTraceWindow', { shown: traceLoaded, total: traceTotal })}</span>
                    <button
                      className="underline"
                      disabled={pending}
                      onClick={loadMoreTrace}
                      type="button"
                    >
                      {pending ? t('caseTraceLoading') : t('caseTraceMore')}
                    </button>
                  </p>
                )}
                <TrajectoryView segments={segments} />
              </div>
            ) : hasTrajectory ? (
              <p className="text-[12px] text-muted-foreground">{t('caseTraceEmpty')}</p>
            ) : null}
            {/* The os-use screenshot — the very screen the VLM graded. As base64 it is hundreds of KB per
                case, so it is fetched here and never in the list. */}
            {detail?.screenshotSrc !== undefined && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={detail.screenshotSrc}
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
            {/* How the case died — the trace's error events (a harness crash, a dispatch error). Until the
                full text arrives, the first line the list already carried stands, so opening a failed case is
                never a moment of silence. */}
            {(detail?.errors ?? (c.errorSummary !== undefined ? [c.errorSummary] : [])).map(
              (message, i) => (
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
              )
            )}
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
                  <ScoreRow
                    score={group.row}
                    siblings={caseMetrics}
                    evidence={findCaseEvidence(detail?.evidence, group.row)}
                  />
                  {group.criteria.map((criterion) => (
                    <ScoreRow
                      key={criterion.row.metric}
                      score={criterion.row}
                      siblings={caseMetrics}
                      evidence={findCaseEvidence(detail?.evidence, criterion.row)}
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

// 실행 매니페스트 스트립 — "이 케이스가 실제로 어떤 세계에서 돌았나". 스코어카드 매니페스트가 평가의
// 정의(데이터셋·하네스·저지 버전)를 고정한다면 이건 평가의 세계를 고정한다.
// osResolved 가 defaulted 면 케이스가 os 를 쓴 적이 없다는 뜻 — 선언된 linux 와 구별되는 사실이라 배지로
// 따로 말한다(설명은 인라인 문구가 아니라 툴팁으로).
function ExecutionStrip({ execution }: { execution: CaseExecutionView }) {
  const t = useTranslations('scorecardsPage')
  const defaulted = execution.osResolved === 'defaulted'
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[12px]">
      <span className="text-faint">{t('caseWorldLabel')}</span>
      <Badge tone="neutral">{execution.os}</Badge>
      {defaulted && (
        <Tooltip content={t('caseWorldDefaultedHint')}>
          <span className="cursor-default rounded border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {t('caseWorldDefaulted')}
          </span>
        </Tooltip>
      )}
      {execution.driver !== undefined && (
        <ExecutionFact label={t('caseWorldDriver')} value={execution.driver} />
      )}
      {execution.runtime !== undefined && (
        <ExecutionFact label={t('caseWorldRuntime')} value={execution.runtime} />
      )}
      {execution.image !== undefined && (
        <ExecutionFact label={t('caseWorldImage')} value={execution.image} truncate />
      )}
    </div>
  )
}

function ExecutionFact({
  label,
  value,
  truncate,
}: {
  label: string
  value: string
  truncate?: boolean
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="text-faint">{label}</span>
      {/* 이미지 레퍼런스는 길다 — 줄바꿈으로 스트립을 무너뜨리지 말고 잘라 두고 전체는 title 로 준다. */}
      <span
        className={cn(
          'font-mono text-[11.5px] text-muted-foreground',
          truncate && 'max-w-64 truncate'
        )}
        title={truncate ? value : undefined}
      >
        {value}
      </span>
    </span>
  )
}

// 한 점수의 값 — categorical `label` 은 그대로(gold / correct / B), 아니면 단위 추론 포맷. 판정 배지가
// 따로 서 있으므로 run 상세의 값 칸처럼 0/1 도 실제 값으로 보여준다.
function displayValue(s: CaseScoreView): string {
  if (s.label !== undefined && s.label !== '') return s.label
  // 측정이 아닌 행은 호출 전에 걸러진다(isUnmeasuredScore) — 그래도 값이 없으면 대시가 정직한 표시다.
  if (s.value === undefined) return '–'
  return fmtMetricValue(classifyMetric({ metric: s.metric, mean: s.value }), s.value)
}

// 한 지표 행 — run 상세 EvalOutcome 의 행 문법과 동일: detail(판정 근거)이 있으면 펼칠 수 있고, 실패한
// 행은 기본으로 펼쳐진다. "왜 실패했나"가 가장 깊은 곳에 접혀 있던 게 이전 케이스 카드의 핵심 문제였다.
function ScoreRow({
  score,
  siblings,
  evidence,
  nested,
}: {
  score: CaseScoreView
  siblings: string[]
  // Evidence arrives after the dialog opens — until then this is an ordinary row with nothing to expand.
  evidence?: CaseScoreEvidence
  nested?: boolean
}) {
  const t = useTranslations('scorecardsPage')
  const hasDetail = classifyScoreDetail(evidence?.detail) !== undefined
  const unmeasured = isUnmeasuredScore(score)
  // undefined = nobody has pressed it yet. That way a failing row still opens itself when its evidence
  // arrives late, and a row somebody closed is not re-opened by that arrival.
  const [toggled, setToggled] = useState<boolean | undefined>(undefined)
  // Gated on hasDetail as well: stepping to a sibling case reuses this row in place, so a `toggled` left
  // over from the previous case could otherwise mark a row with no evidence as open.
  const open = hasDetail && (toggled ?? score.pass === false)
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
        <button type="button" onClick={() => setToggled(!open)} className="block w-full">
          {body}
        </button>
      ) : (
        body
      )}
      {/* On a row that is not a measurement, "why it could not be measured" IS the row — a value cell saying
          only "unmeasured", with the reason nowhere, leaves nothing to read. */}
      {unmeasured && evidence?.reason !== undefined && (
        <p className="px-3 pb-2 text-[12px] text-muted-foreground">{evidence.reason}</p>
      )}
      {open && <ScoreDetail detail={evidence?.detail} className="mx-3 mb-3" />}
    </div>
  )
}
