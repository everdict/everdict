import { ChevronLeft, Download } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { MentionInChatButton, OpenConversationButton } from '@/widgets/infra-panel'
import { LiveLogs } from '@/widgets/live-logs'
import { ReplayPlayer } from '@/widgets/replay-player'
import { RunPlacement } from '@/widgets/run-placement'
import { RunTopology } from '@/widgets/run-topology'
import { LiveScreen, LiveTerminal } from '@/widgets/sandbox-terminal'
import { asSingleSegment, TrajectoryView, type TrajectorySegment } from '@/features/browse-traces'
import { CommentsSection } from '@/features/discuss'
import { membersSchema } from '@/entities/member'
import {
  RUN_KIND_META,
  runCaseSpecSchema,
  runKindOf,
  RunOutcome,
  runSchema,
  trajectoryResponseSchema,
  type Run,
  type RunCaseSpec,
} from '@/entities/run'
import { traceEventSchema, type TraceEvent } from '@/entities/trace'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtSubject, fmtTokens, fmtUsd } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { RuntimeChip } from '@/shared/ui/chip'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatusPill } from '@/shared/ui/status-pill'

export const dynamic = 'force-dynamic'

// os-use screenshot src: inline base64 (dev) → data URL, else object storage URL (offloaded). undefined if neither.
function osUseShotSrc(snapshot?: {
  screenshot?: string
  screenshotRef?: string
}): string | undefined {
  if (snapshot?.screenshot) return `data:image/png;base64,${snapshot.screenshot}`
  if (snapshot?.screenshotRef && /^https?:\/\//.test(snapshot.screenshotRef))
    return snapshot.screenshotRef
  return undefined
}

// 스냅샷에 실제로 보여줄 내용이 있는지 — 없으면 상세에서 스냅샷 섹션을 통째로 숨긴다(빈 섹션 규칙). prompt(환경-없는 QA)는
// 최종 답변(output)이 대개 비어 있어(주 신호는 trace) 예전엔 `{kind:"prompt",output:""}` 원시 JSON만 떠서 "매번 빈 스냅샷"으로
// 보였다. 이 게이트가 그 문제를 없앤다. docs/web.md — 빈 섹션은 통째로 숨긴다("none" 플레이스홀더 금지).
function snapshotHasContent(s: NonNullable<Run['result']>['snapshot']): boolean {
  if (!s) return false
  if (osUseShotSrc(s)) return true // 어떤 kind든 캡처된 화면이 있으면 표시할 게 있다
  switch (s.kind) {
    case 'prompt':
      return Boolean(s.output?.trim())
    case 'os-use':
      return Boolean(s.windows?.length)
    case 'repo':
      return Boolean(s.diff?.trim() || s.changedFiles?.length)
    case 'browser':
      return Boolean(s.url || s.dom || s.domRef)
    default:
      return Boolean(s.url || s.dom || s.output?.trim())
  }
}

// The evidence view (TrajectoryView, shared with Settings › Observability) reads the CONTRACT-shaped trace union,
// while this page parses the run record loosely on purpose (`entities/run`'s passthrough consumer view, so a
// server-side trace-kind addition never rejects the whole run). Re-parse the same array through the strict lens,
// PER EVENT: an event kind this build doesn't model yet drops out of the evidence view instead of blanking the
// page. No extra fetch — same bytes, second lens.
function toEvidence(events: unknown[]): TraceEvent[] {
  const evidence: TraceEvent[] = []
  for (const event of events) {
    const parsed = traceEventSchema.safeParse(event)
    if (parsed.success) evidence.push(parsed.data)
  }
  return evidence
}

// Source (the activity view's source axis) → the shared human label (reused from the runs-table). Unset = direct API.
const SOURCE_KEY: Record<string, string> = {
  web: 'sourceWeb',
  mcp: 'sourceMcp',
  api: 'sourceApi',
  scorecard: 'sourceScorecard',
  schedule: 'sourceSchedule',
  'front-door': 'sourceFrontDoor',
}

// One labeled cell of the meta card (dt/dd). Rich cells (runtime chip, scorecard link) pass `children`; `Prop` is the
// plain-text convenience over it (harness/case/source/run-by/created/updated).
function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  )
}

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <MetaItem label={label}>
      <span className="block truncate font-mono text-[13px] text-foreground">{value}</span>
    </MetaItem>
  )
}

// One economics stat of the usage card (cost / tokens / calls) — a single run's own cost, which a scorecard only
// aggregates. `usage` is derived from the trace on read (usageFromTrace), so it needs no separate fetch.
function UsageStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 font-mono text-[15px] font-[560] tabular-nums">{value}</div>
    </div>
  )
}

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/runs`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </Link>
  )
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('runsPage')
  const timeZone = await getTimeZone()
  const ctx = await authContext()

  let run: Run | undefined
  let error: string | undefined
  // caseSpec 은 같은 응답을 좁은 렌즈로 한 번 더 읽는다(runCaseSpecSchema 주석 참고 — 전체 EvalCase 를
  // 미러링하면 드리프트 가드가 깨진다). 실패해도 상세는 그대로 뜬다: 요청 섹션만 빠진다.
  let caseSpec: RunCaseSpec | undefined
  try {
    const raw = await controlPlane.getRun(ctx, id)
    run = runSchema.parse(raw)
    caseSpec = runCaseSpecSchema.safeParse(raw).data?.caseSpec
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!run) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} label={t('title')} />
        <PageHeader title={t('runLabel')} />
        <Callout tone="danger">{t('runLoadError', { error: error ?? '' })}</Callout>
      </div>
    )
  }

  const snapshot = run.result?.snapshot
  const usage = run.usage

  // Trace: the row embed first (legacy eval runs), else the OWNED trajectory store (N1 look-inward) — the
  // sealed evidence is how agent/sandbox/OTLP runs render at all (they never carry a result embed).
  // Soft-fail: an unsealed run simply has no trace section yet.
  //
  // `segments` is what the evidence view reads: one plane per EMITTER (the execution's own stream plus each
  // service that pushed its own OTel spans into this run). The run-scoped read carries them, so one fetch
  // serves both — and a row embed is a single plane the page builds with no fetch at all.
  let trace = run.result?.trace ?? []
  let trajectorySource: string | undefined
  let segments: TrajectorySegment[] = []
  if (trace.length === 0) {
    try {
      const runScoped = trajectoryResponseSchema.parse(await controlPlane.getRunTrajectory(ctx, id))
      trace = runScoped.events
      trajectorySource = runScoped.meta.source
      segments =
        runScoped.segments.length > 0
          ? runScoped.segments.map((segment) => ({
              ...segment,
              // The execution segment omits its events on the wire (never shipped twice) — rehydrate it here.
              events: toEvidence(segment.events ?? runScoped.events),
            }))
          : // 세그먼트를 아직 안 보내는 봉인 기록(다중 평면 등급 이전에 봉인된 것들 — 오늘 살아 있는 에이전트
            // 턴이 전부 여기 해당한다)은 실행 자신의 스트림이 곧 궤적 전체다. 이 폴백이 없으면 이벤트가 있는데도
            // 증거 섹션이 통째로 사라진다. browse-trajectories 액션이 같은 폴백을 갖고 있다.
            asSingleSegment(toEvidence(runScoped.events), 'run')
    } catch {
      // 404 = nothing sealed (and no embed) — the page just omits the trace sections.
    }
  } else {
    segments = asSingleSegment(toEvidence(trace), 'run', run.result?.traceT0)
  }

  // Replay is available for any settled run that produced an agent trace (EVERY harness does) or a recording —
  // not only ones with environment frames. A still-running run shows the live section instead. The agent trace is
  // the universal replay spine; frames are a per-kind addition. docs/architecture/replay.md (Principle 1).
  const isTerminal = run.status === 'succeeded' || run.status === 'failed'
  const hasReplay = isTerminal && (trace.length > 0 || run.result?.recordingRef != null)

  // Source label — reuse the runs-table's shared source vocabulary (web/mcp/api/scorecard/schedule/front-door).
  const tTable = await getTranslations('runsTable')
  const sourceKey = run.trigger ? SOURCE_KEY[run.trigger] : undefined
  const sourceText = run.trigger
    ? sourceKey
      ? tTable(sourceKey)
      : run.trigger
    : tTable('sourceDirect')

  // Run-by name (members join) — supplementary, so the detail still renders if it fails. Name is profile name > email
  // local part > shortened subject. Machine-fired runs (createdBy unset) skip the lookup and hide the cell.
  let authorName: string | undefined
  if (run.createdBy) {
    const createdBy = run.createdBy
    const members = await controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch(() => [])
    const m = members.find((x) => x.subject === createdBy)
    authorName = m?.name ?? m?.email?.split('@')[0] ?? fmtSubject(createdBy)
  }

  // Runtime this run was placed on — a registered runtime links to its detail; a self-hosted runner (self / self:<id>)
  // shows a generic label with no link (multi-tenant: it may be another member's personal device, no screen to open).
  const runtime = run.runtime
  const runtimeIsSelfHosted = runtime === 'self' || (runtime?.startsWith('self:') ?? false)

  // 메타 카드의 두 축은 컬럼이 같고 의미가 kind 마다 다르다 — 도메인의 팩토리가 그렇게 채운다(하네스 컬럼에
  // 에이전트 스펙/환경 capability 가 들어가고, caseId 에 깨운 원인/이미지가 들어간다). 라벨을 harness/case 로
  // 고정해 두면 챗 턴이 "case chat", 샌드박스가 "case ubuntu:24.04" 로 읽히는 거짓말이 남는다.
  const subjectLabel =
    run.kind === 'agent' ? 'agent' : run.kind === 'sandbox' ? 'environment' : 'harness'
  const objectLabel = run.kind === 'agent' ? 'cause' : run.kind === 'sandbox' ? 'image' : 'case'

  // 라이브 패널은 run 이 선언한 채널만 연다. 예전에는 여기서 kind 로 "컨테이너 기반이겠지"를 추측했는데,
  // 그러면 클러스터에서 돈 실행과 남의 노트북(self-hosted)에서 돈 실행에 같은 약속을 하고 다른 걸 준다.
  // 이제 판단은 컨트롤 플레인 한 곳(domain 의 attachChannelsFor)에 있고 — 선언이 없던 옛 run 도 읽을 때
  // 같은 규칙으로 채워져 온다 — 여기서는 선언을 읽기만 한다.
  const attach = run.attach ?? []
  const showLiveLogs = attach.includes('logs')
  const showTerminal = attach.includes('exec') || attach.includes('terminal')

  // 이 run 을 일으킨 run — 수요 그래프의 간선(에이전트가 제출한 실행이 대표적). 부모 그룹은 스코어카드면
  // 메타 카드가 이미 링크하므로, 여기서는 그 밖의 그룹(플레이그라운드 세션의 케이스)만 세운다.
  const causedByRunId = run.origin?.causedByRunId
  const sessionRunId =
    run.group?.role === 'case' && !run.parentScorecardId ? run.group.id : undefined

  return (
    // @container: the sections below size off THIS column's width, not the viewport's — the infra panel splits
    // the page, so a viewport breakpoint would keep promising space this column no longer has.
    <div className="@container space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('title')} />
        <PageHeader
          title={<span className="font-mono">run {run.id.slice(0, 8)}</span>}
          description={t('runDescription', {
            harness: `${run.harness.id}@${run.harness.version}`,
            caseId: run.caseId,
          })}
          actions={
            <div className="flex items-center gap-2">
              <MentionInChatButton
                reference={{ type: 'run', id: run.id, label: run.id.slice(0, 8) }}
                mission="runAnalyze"
              />
              {/* 실행 패밀리 — eval 이 아닌 run 만 배지를 단다(활동 콘솔의 행과 같은 규칙). 이게 없으면
                  에이전트 턴과 샌드박스 세션이 하네스 eval 처럼 읽힌다: 컬럼은 같고 의미가 다르다. */}
              {runKindOf(run) !== 'eval' && (
                <Badge tone="info">{tTable(RUN_KIND_META[runKindOf(run)].labelKey)}</Badge>
              )}
              {/* 재생 가능한 run이면 "리플레이" 배지 → 아래 #replay 섹션으로 점프(발견성). agent trace만 있어도
                  재생되므로(하네스 무관) recordingRef 없이 trace만으로도 노출한다. */}
              {hasReplay && (
                <a href="#replay" className="no-underline">
                  <Badge tone="info">{t('replay')}</Badge>
                </a>
              )}
              {/* 세션 run 은 `running` 이 "진행 중"이 아니라 "살아 있음"이고, `succeeded` 는 "회수됨"이다 —
                  상태 옆에 그 사실을 세워 두지 않으면 ops 뷰가 건강한 세션을 멈춘 배치로 읽는다. */}
              {run.lifetime === 'session' && (
                <Badge tone="neutral">
                  {run.status === 'running' ? t('sessionAlive') : t('sessionClosed')}
                </Badge>
              )}
              <StatusPill status={run.status} />
            </div>
          }
        />
      </div>

      <Card className="grid grid-cols-2 gap-4 p-4 @2xl:grid-cols-4">
        <Prop label={subjectLabel} value={`${run.harness.id}@${run.harness.version}`} />
        <Prop label={objectLabel} value={run.caseId} />
        {/* Runtime (where it ran) — registered runtime links out; a self-hosted runner shows a label only. Hidden if unset (legacy / default backend). */}
        {runtime && (
          <MetaItem label={t('metaRuntime')}>
            {runtimeIsSelfHosted ? (
              <RuntimeChip label={t('runtimeSelfHosted')} />
            ) : (
              <Link
                href={`/${workspace}/runtime/${encodeURIComponent(runtime)}`}
                className="rounded-sm hover:underline"
                title={t('runtimeDetailTitle')}
              >
                <RuntimeChip label={runtime} />
              </Link>
            )}
          </MetaItem>
        )}
        {/* Source (why this run happened) + run-by (who) — the activity view's provenance axes, folded into the meta card. */}
        <Prop label={t('metaSource')} value={sourceText} />
        {authorName && <Prop label={t('metaRunBy')} value={authorName} />}
        <Prop
          label="created"
          value={new Date(run.createdAt).toLocaleString(undefined, { timeZone })}
        />
        <Prop
          label="updated"
          value={new Date(run.updatedAt).toLocaleString(undefined, { timeZone })}
        />
        {/* Batch child run → back-link to the scorecard it belongs to (standalone runs have no parent, so hidden). */}
        {run.parentScorecardId && (
          <MetaItem label={t('metaScorecard')}>
            <Link
              href={`/${workspace}/scorecard/${encodeURIComponent(run.parentScorecardId)}`}
              className="inline-flex items-center gap-1 font-mono text-[13px] text-link transition-colors hover:text-foreground"
            >
              {run.parentScorecardId.slice(0, 8)} →
            </Link>
          </MetaItem>
        )}
        {/* 이 run 을 일으킨 run — 클릭 가능한 인과 간선. 에이전트가 제출한 실행이면 여기서 그 에이전트 턴으로
            거슬러 올라갈 수 있다(수요 그래프이자 감사 추적). */}
        {causedByRunId && (
          <MetaItem label={t('metaCausedBy')}>
            <Link
              href={`/${workspace}/run/${encodeURIComponent(causedByRunId)}`}
              className="inline-flex items-center gap-1 font-mono text-[13px] text-link transition-colors hover:text-foreground"
            >
              {causedByRunId.slice(0, 8)} →
            </Link>
          </MetaItem>
        )}
        {/* 세션 안에서 제출된 케이스(플레이그라운드) → 그 세션 run 으로. 스코어카드 자식은 위 셀이 맡는다. */}
        {sessionRunId && (
          <MetaItem label={t('metaSessionRun')}>
            <Link
              href={`/${workspace}/run/${encodeURIComponent(sessionRunId)}`}
              className="inline-flex items-center gap-1 font-mono text-[13px] text-link transition-colors hover:text-foreground"
            >
              {sessionRunId.slice(0, 8)} →
            </Link>
          </MetaItem>
        )}
      </Card>

      {/* 요청 — 무엇을 시켰나. 케이스 본문을 persist 하는 run(단독 제출·플레이그라운드 케이스)만 가지며,
          이게 없어서 "이 run 이 무슨 과제를 받았는지"를 상세에서 전혀 볼 수 없었다. 없으면 섹션도 없다. */}
      {caseSpec && caseSpec.task.trim() !== '' && (
        <section className="space-y-2.5">
          <SectionHeader
            title={t('requestTitle')}
            action={
              caseSpec.timeoutSec !== undefined ? (
                <span className="font-mono text-[11px] text-faint">
                  {t('requestTimeout', { sec: caseSpec.timeoutSec })}
                </span>
              ) : undefined
            }
          />
          <Card className="p-4">
            <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed">
              {caseSpec.task}
            </p>
            {caseSpec.tags.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {caseSpec.tags.map((tag) => (
                  <Badge key={tag} tone="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </Card>
        </section>
      )}

      {/* Usage (this run's own economics) — cost · tokens · calls, derived from the trace. A scorecard only aggregates
          these across cases; a single run reports its own. Hidden until there's a non-zero trace-derived usage. */}
      {usage && (usage.usd > 0 || usage.totalTokens > 0) && (
        <Card className="flex flex-wrap items-center gap-x-8 gap-y-2 p-4">
          <UsageStat label={t('usageCost')} value={fmtUsd(usage.usd)} />
          <UsageStat
            label={t('usageTokens')}
            value={fmtTokens(usage.totalTokens)}
            hint={t('usageTokensBreakdown', {
              prompt: usage.promptTokens,
              completion: usage.completionTokens,
            })}
          />
          <UsageStat label={t('usageCalls')} value={String(usage.calls)} />
          {/* 위임받은 예산의 캡 — 이 run 이 어느 봉투에서 끌어 쓰는지(에이전트가 위임한 슬라이스가 대표적).
              캡이 없으면 셀 자체가 없다. */}
          {run.envelope?.capUsd !== undefined && (
            <UsageStat label={t('usageBudget')} value={fmtUsd(run.envelope.capUsd)} />
          )}
        </Card>
      )}

      {run.error && (
        <Callout tone="danger" hint={run.error.message}>
          {run.error.code}
        </Callout>
      )}

      {(run.status === 'queued' || run.status === 'running') && (
        <section className="space-y-4">
          {/* live trace deep-link — the platform trace is accumulating under this correlation id right now */}
          {run.liveTrace && (
            <Callout tone="info" hint={`everdict.run_id=${run.liveTrace.runId}`}>
              {t('liveTrace', { kind: run.liveTrace.kind })}{' '}
              <a
                href={run.liveTrace.endpoint}
                target="_blank"
                rel="noreferrer"
                className="break-all font-mono underline underline-offset-2"
              >
                {run.liveTrace.endpoint}
              </a>
            </Callout>
          )}
          {/* 케이스 배치(런타임 디버깅) — 클러스터가 케이스를 어디까지 받아들였는지(blocked 용량 판정·노드·
              오케스트레이터 이벤트 피드)를 폴링; 배치 정보가 없는 run이면 위젯이 self-null (빈 섹션 없음) */}
          <RunPlacement runId={run.id} initialStatus={run.status} />
          {/* 토폴로지 헬스(서비스 하네스) — 웜 토폴로지의 서비스별 상태(재시작·OOM·최근 이벤트)+행별 로그 펼침;
              서비스 하네스가 아니면 위젯이 self-null */}
          <RunTopology runId={run.id} initialStatus={run.status} />
          {/* 라이브 화면 — browser(browser-use 등)/os-use 케이스면 실행 중 화면을 CDP/scrot/러너-푸시 프레임으로
              2초마다 폴링; 라이브 화면이 없는 run이면 위젯이 self-null (빈 섹션 없음) */}
          <LiveScreen runId={run.id} initialStatus={run.status} />
          {/* 로그·터미널은 run 이 선언한 채널(attach)일 때만 — 붙을 곳 없는 run 에서 영원히 비어 있는 패널을
              띄우지 않는다. 선언이 없는 예전 eval/command run 은 종전대로 둘 다 연다. */}
          {showLiveLogs && (
            <div className="space-y-2.5">
              <SectionHeader title={t('liveLogs')} />
              <Card className="p-4">
                <LiveLogs runId={run.id} initialStatus={run.status} />
              </Card>
            </div>
          )}
          {/* 샌드박스 터미널 — 실행 중인 케이스 컨테이너로 들어가는 대화형 셸(cd·env 유지). 셸은 샌드박스의 실제
              프로세스라 "셸 열기"를 눌렀을 때만 붙는다 (creator/admin, 컨트롤플레인이 강제) */}
          {showTerminal && (
            <div className="space-y-2.5">
              <SectionHeader title={t('sandbox')} />
              <Card className="p-4">
                <LiveTerminal runId={run.id} />
              </Card>
            </div>
          )}
        </section>
      )}

      {/* 리플레이 — 종료된 run의 앵커 섹션. agent trace(모든 하네스 공통)를 벽시계로 스크럽하고, 녹화 프레임이
          있으면 그 시점 화면을 오버레이한다. 헤더 "리플레이" 배지가 여기로 점프한다. docs/architecture/replay.md */}
      {hasReplay && (
        <div id="replay" className="scroll-mt-6">
          <ReplayPlayer runId={run.id} initialStatus={run.status} trace={trace} />
        </div>
      )}

      {/* 결과 — kind 마다 갈아끼우는 단 하나의 슬롯. eval 이면 판정 한 줄 + 지표 표(근거는 행 확장), 에이전트
          턴이면 그 대화로 건너가기, 샌드박스면 세션 요약. 점수는 eval 의 결과일 뿐 보편 결과가 아니므로,
          점수가 없는 패밀리에서 "아직 점수가 없어요"를 띄우던 영구 빈 섹션은 사라졌다.
          스코어카드의 케이스 run 은 점수를 여기서 반복하지 않는다 — 점수의 권위 표면은 스코어카드 상세(케이스별
          판정·지표 표를 이미 소유)이고, run 상세는 실행 기록(리플레이·라이브·궤적·논의)이다. */}
      {!run.parentScorecardId && (
        <RunOutcome
          run={run}
          action={
            run.group?.role === 'turn' ? (
              <OpenConversationButton sessionId={run.group.id} />
            ) : undefined
          }
        />
      )}

      {/* Evidence — the SAME reading surface as Settings › Observability's sealed-trajectory detail (rollup ·
          plane chips · event list left / full payload right). The run page's bespoke vertical timeline is gone:
          one trace UI, so a payload read here is the payload read there. Hidden entirely when there is nothing
          sealed yet (empty sections are never placeholders). The panes scroll on their own, so the card fixes a
          height; TrajectoryView is its own @container, so it stacks when the infra panel narrows this column. */}
      {segments.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('trace')} />
          {/* Served from the owned store (no row embed): say so — the evidence survives independent of any
              external platform, and `source` is its provenance (run | otlp | import). */}
          {trajectorySource !== undefined && (
            <p className="text-xs text-muted-foreground">
              {t('sealedEvidence', { source: trajectorySource })}
            </p>
          )}
          <Card className="h-[68vh] min-h-[420px] p-4">
            <TrajectoryView segments={segments} />
          </Card>
        </section>
      )}

      {snapshot && snapshotHasContent(snapshot) && (
        <section className="space-y-2.5">
          <SectionHeader title={t('snapshot', { kind: String(snapshot.kind) })} />
          <Card className="space-y-3 p-4">
            {/* os-use screenshot — inline base64 (dev) or object storage URL (offloaded). The final screen the agent saw. */}
            {osUseShotSrc(snapshot) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={osUseShotSrc(snapshot)}
                alt="os-use screenshot"
                className="max-h-[480px] w-auto max-w-full rounded-lg border"
              />
            )}
            {/* prompt (환경-없는 QA) — 최종 답변 텍스트. 주 신호는 trace라 비어 있는 경우가 흔해, 값이 있을 때만 이 섹션이 뜬다
                (snapshotHasContent 게이트). 예전엔 `{kind:"prompt",output:""}` 원시 JSON만 떠서 "매번 빈 스냅샷"으로 보였다. */}
            {snapshot.kind === 'prompt' && snapshot.output && (
              <div>
                <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                  {t('snapshotOutput')}
                </dt>
                <dd className="mt-0.5 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-2 font-mono text-[13px]">
                  {snapshot.output}
                </dd>
              </div>
            )}
            {/* os-use — the titles of visible windows (OSWorld-style desktop). */}
            {snapshot.kind === 'os-use' && snapshot.windows && snapshot.windows.length > 0 && (
              <div>
                <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                  {t('snapshotWindows')}
                </dt>
                <dd className="mt-0.5 flex flex-wrap gap-1.5">
                  {snapshot.windows.map((w, i) => (
                    <span
                      key={`${w}-${i}`}
                      className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground"
                    >
                      {w}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            {/* repo — the final changed-files list + the git diff (the coding harness's result world). */}
            {snapshot.kind === 'repo' && (
              <div className="space-y-2">
                {snapshot.changedFiles && snapshot.changedFiles.length > 0 && (
                  <div>
                    <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                      {t('snapshotChangedFiles')}
                    </dt>
                    <dd className="mt-0.5 flex flex-wrap gap-1.5">
                      {snapshot.changedFiles.map((f) => (
                        <span
                          key={f}
                          className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground"
                        >
                          {f}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
                {snapshot.diff && (
                  <div>
                    <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                      {t('snapshotDiff')}
                    </dt>
                    <dd className="mt-0.5 max-h-80 overflow-auto whitespace-pre rounded-lg border border-border bg-muted/40 p-2 font-mono text-[12px] text-muted-foreground">
                      {snapshot.diff}
                    </dd>
                  </div>
                )}
              </div>
            )}
            {/* browser (service-topology: browser-use, etc.) — the final URL the agent reached + an extracted DOM excerpt. */}
            {snapshot.kind === 'browser' && (
              <div className="space-y-2">
                {snapshot.url && (
                  <div>
                    <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                      final url
                    </dt>
                    <dd className="mt-0.5 break-all font-mono text-[13px]">{snapshot.url}</dd>
                  </div>
                )}
                {snapshot.dom && (
                  <div>
                    <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                      dom / extracted
                    </dt>
                    <dd className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-2 font-mono text-[12px] text-muted-foreground">
                      {snapshot.dom}
                    </dd>
                  </div>
                )}
                {/* Full page DOM offloaded to object storage — the inline `dom` above is only an 8KB preview. The ref is a
                    presigned URL (S3/MinIO), so a plain download link; hidden for the dev in-memory store's memory:// ref. */}
                {snapshot.domRef && /^https?:\/\//.test(snapshot.domRef) && (
                  <a
                    href={snapshot.domRef}
                    target="_blank"
                    rel="noreferrer"
                    download
                    className="inline-flex items-center gap-1.5 text-[12px] font-[510] text-link transition-colors hover:text-foreground"
                  >
                    <Download className="size-3.5" />
                    {t('downloadDom')}
                  </a>
                )}
              </div>
            )}
          </Card>
        </section>
      )}

      <CommentsSection
        workspace={workspace}
        resourceType="run"
        resourceId={id}
        title={t('discuss')}
      />
    </div>
  )
}
