import { ChevronLeft, Download } from 'lucide-react'
import { getLocale, getTimeZone, getTranslations } from 'next-intl/server'

import { MentionInChatButton } from '@/widgets/infra-panel'
import {
  OpenCaseChip,
  ScorecardCaseList,
  ScorecardCasesProvider,
  type ScorecardCaseView,
} from '@/widgets/scorecard-cases'
import { DeleteScorecardButton } from '@/features/delete-scorecard'
import { CommentsSection } from '@/features/discuss'
import { moveDestinationsFor, TeamOwnerControl } from '@/features/move-to-team'
import { RerunScorecardButton } from '@/features/rerun-scorecard'
import { RescoreScorecardButton } from '@/features/rescore-scorecard'
import { StopScorecardButton } from '@/features/stop-scorecard'
import { datasetSchema, type DatasetCase } from '@/entities/dataset'
import { judgesSchema, type JudgePickerChoice } from '@/entities/judge'
import { membersSchema } from '@/entities/member'
import { runsSchema, type RunStatus } from '@/entities/run'
import { runnersResponseSchema, type RunnerMeta } from '@/entities/runner'
import { runtimesSchema } from '@/entities/runtime'
import {
  isTraceEvaluation,
  scorecardRecordSchema,
  type MetricSummary,
  type ScorecardRecord,
} from '@/entities/scorecard'
import { teamsSchema } from '@/entities/team'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import {
  classifyMetric,
  fmtElapsed,
  fmtMetricValue,
  fmtPct,
  fmtSubject,
  fmtTimeAgo,
  groupMetricRows,
  HEALTH_TEXT,
  rateHealth,
} from '@/shared/lib/format'
import { resolveTemporalUiBase } from '@/shared/lib/temporal-ui'
import { cn } from '@/shared/lib/utils'
import { AutoRefresh } from '@/shared/ui/auto-refresh'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EntityRef, ModelChip, RuntimeChip } from '@/shared/ui/chip'
import { DistributionBar } from '@/shared/ui/distribution-bar'
import { ExpandableText } from '@/shared/ui/expandable-text'
import { Link } from '@/shared/ui/link'
import { CriterionBadge, MetricLabel } from '@/shared/ui/metric-label'
import { OriginInline, OriginPins } from '@/shared/ui/origin'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatCard } from '@/shared/ui/stat-card'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'
import { InfoTip } from '@/shared/ui/tooltip'

// pass-rate tone shared by pass@1 / pass@k stat cards (mirror of the case rollup's pass-rate thresholds).
function rateTone(rate: number): 'success' | 'default' | 'danger' {
  return rate >= 0.75 ? 'success' : rate >= 0.4 ? 'default' : 'danger'
}

export const dynamic = 'force-dynamic'

// os-use screenshot src: base64 embedded (dev) → data URL, otherwise object storage URL (offload). undefined if neither.
function osUseShotSrc(snapshot?: {
  screenshot?: string
  screenshotRef?: string
}): string | undefined {
  if (snapshot?.screenshot) return `data:image/png;base64,${snapshot.screenshot}`
  if (snapshot?.screenshotRef && /^https?:\/\//.test(snapshot.screenshotRef))
    return snapshot.screenshotRef
  return undefined
}

// The runtime a batch ran on → a display name + optional detail link.
// - Registered runtime: the id IS its name → links to the runtime detail page.
// - Self-hosted runner (self / self:<id> / self:ws:<id>): show the runner's friendly device name (resolved from the
//   workspace roster; pools get an "(any)" label) but NEVER link out. This is a multi-tenant service — a batch may
//   have run on another member's personal runner, which has no screen the viewer can (or should) navigate to.
function runtimeDisplay(
  target: string,
  opts: {
    workspace: string
    runnerLabelOf: (id: string) => string | undefined
    poolPersonalLabel: string
    poolWorkspaceLabel: string
  }
): { label: string; href?: string } {
  const { workspace, runnerLabelOf, poolPersonalLabel, poolWorkspaceLabel } = opts
  const isSelfHosted = target === 'self' || target.startsWith('self:')
  if (!isSelfHosted) {
    return { label: target, href: `/${workspace}/runtime/${encodeURIComponent(target)}` }
  }
  const label =
    target === 'self'
      ? poolPersonalLabel
      : target === 'self:ws'
        ? poolWorkspaceLabel
        : target.startsWith('self:ws:')
          ? (runnerLabelOf(target.slice('self:ws:'.length)) ?? target)
          : (runnerLabelOf(target.slice('self:'.length)) ?? target)
  return { label }
}

// One labeled cell of the meta card (dt/dd). Rich cells (entity links, origin, chips) pass `children`;
// `Prop` is the plain-text convenience over it (created/updated/run-by/…).
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

// A clickable entity reference in the meta card — the entity chip (icon + id@version), links to its detail page.
function EntityMetaLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex max-w-full rounded-sm text-[13px] text-foreground transition-colors hover:underline"
    >
      {children}
    </Link>
  )
}

// A health-colored proportion bar (0..1) — the visual for a pass/fail metric's pass rate.
function ProportionBar({ value }: { value: number }) {
  const health = rateHealth(value)
  const bg =
    health === 'good'
      ? 'var(--color-success)'
      : health === 'mid'
        ? 'var(--color-warning)'
        : 'var(--color-destructive)'
  return (
    <div
      className="h-2 w-full min-w-16 overflow-hidden rounded-full bg-muted/40"
      title={fmtPct(value)}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.round(value * 100)}%`, backgroundColor: bg }}
      />
    </div>
  )
}

// The "value" cell of a metric-summary row — kind-aware so each metric reads in its own terms rather than a uniform
// "0.50": a categorical metric shows its label distribution, a pass/fail metric its proportion bar WITH the rate
// beside it, and a numeric metric its mean with the right unit ($ / s / % / 1.2k). The former standalone
// "pass rate" column is gone — it only meant something for pass/fail metrics and printed "—" for every numeric
// one, so the rate now rides the value cell of exactly the metrics it describes. Shared by judge-overall rows
// and their criterion sub-rows. A zero-measurement metric has NO mean — it renders the unmeasured label (passed
// in: this is a sync server component without its own t), and its unmeasured tally rides the count cell so the
// outage stays visible.
function SummaryCells({ m, unmeasuredLabel }: { m: MetricSummary; unmeasuredLabel: string }) {
  const kind = classifyMetric(m)
  return (
    <>
      <TD className="min-w-40">
        {kind === 'categorical' && m.distribution ? (
          <DistributionBar segments={m.distribution} mode={m.mode} />
        ) : kind === 'passfail' && m.passRate != null ? (
          <span className="flex items-center gap-2.5">
            <ProportionBar value={m.passRate} />
            <span
              className={cn(
                'shrink-0 font-mono text-[12px] tabular-nums',
                HEALTH_TEXT[rateHealth(m.passRate)]
              )}
            >
              {fmtPct(m.passRate)}
            </span>
          </span>
        ) : m.mean !== undefined ? (
          <span className="font-mono text-[12px] tabular-nums">{fmtMetricValue(kind, m.mean)}</span>
        ) : (
          <span className="text-[12px] text-amber-500/90">{unmeasuredLabel}</span>
        )}
      </TD>
      <TD className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
        {m.count}
        {m.unmeasured != null && m.unmeasured > 0 && (
          <span className="text-amber-500/80" title={unmeasuredLabel}>
            {' '}
            (−{m.unmeasured})
          </span>
        )}
      </TD>
    </>
  )
}

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/scorecards`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </Link>
  )
}

// Case filter segment — all ↔ failed only (#cases anchor keeps scroll). Server component, so toggle via URL param.
function CaseFilterTab({
  href,
  active,
  danger,
  children,
}: {
  href: string
  active: boolean
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={cn(
        'px-2.5 py-1 text-[12px] font-[510] tabular-nums transition-colors first:border-l-0 [&:not(:first-child)]:border-l',
        active
          ? danger
            ? 'bg-destructive/15 text-destructive'
            : 'bg-elevated text-foreground'
          : 'text-muted-foreground hover:bg-elevated hover:text-foreground'
      )}
    >
      {children}
    </Link>
  )
}

export default async function ScorecardDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ cases?: string; case?: string }>
}) {
  const { workspace, id } = await params
  const { cases, case: caseParam } = await searchParams
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('scorecardsPage')

  let record: ScorecardRecord | undefined
  let error: string | undefined
  try {
    record = scorecardRecordSchema.parse(await controlPlane.getScorecard(ctx, id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!record) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader title={t('scorecardLabel')} />
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      </div>
    )
  }

  // Run-by name (members join) — supplementary info, so the detail still renders even if it fails. Name is profile name > email local part > shortened subject.
  let authorName: string | undefined
  if (record.createdBy) {
    const createdBy = record.createdBy
    const members = await controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch(() => [])
    const m = members.find((x) => x.subject === createdBy)
    authorName = m?.name ?? m?.email?.split('@')[0] ?? fmtSubject(createdBy)
  }

  // 소유 팀을 이름으로 부르고, 넘길 수 있는 사람에게는 그 자리에서 다시 세우게 하기 위한 로스터. 배치는
  // 능력이 만든 증거라, 하네스가 팀을 옮겨도 과거 결과는 따라가지 않는다 — 여기서 따로 옮긴다.
  const teams = await controlPlane
    .listTeams(ctx)
    .then((r) => teamsSchema.parse(r))
    .catch(() => [])
  const teamMove = moveDestinationsFor(principal, teams, 'scorecards:run')

  const summary = record.summary ?? []
  const summaryMetrics = summary.map((m) => m.metric) // sibling context for judge-metric disambiguation
  const judges = record.orchestration?.judges ?? [] // Agent Judges applied to this batch → entity links in the meta card
  // Temporal UI base for the workflow chip — loopback TEMPORAL_UI_URL is rebased onto the request host
  // (self-hosted: the operator's localhost is not the browser's localhost). Unset → the chip is plain text.
  const temporalUiBase = record.orchestration?.workflowId
    ? await resolveTemporalUiBase()
    : undefined
  const results = record.scorecard?.results ?? []
  const steps = record.steps ?? []
  const live = record.status === 'queued' || record.status === 'running'

  // The per-case verdict is server-computed (served field) — shared across rollup · sort · filter.
  const cased = results.map((r) => ({ r, verdict: r.verdict }))
  const passed = cased.filter((c) => c.verdict === true).length
  const failedCount = cased.filter((c) => c.verdict === false).length
  const skipped = cased.filter((c) => c.verdict == null).length
  // The headline pass rate CONSUMES the served rollup — passed/VERDICTED, never passed/executed. Dividing by
  // results.length put infra-failed/unmeasured/cancelled cases in the denominator, so a half-dead runner read
  // as a 50% product failure — exactly the conflation the served casePass/outcomes exist to prevent. The
  // local verdict counts above remain only as a fallback for legacy responses without the served field.
  const verdictedTotal = record.casePass?.total ?? passed + failedCount
  const passRate = verdictedTotal > 0 ? (record.casePass?.pass ?? passed) / verdictedTotal : null

  // Failure-first sort (fail → skip → pass), then failed-only/all filter.
  const filter = cases === 'failed' ? 'failed' : 'all'
  const weight = (v: boolean | undefined) => (v === false ? 0 : v == null ? 1 : 2)
  const ordered = [...cased].sort((a, b) => weight(a.verdict) - weight(b.verdict))
  const shown = filter === 'failed' ? ordered.filter((c) => c.verdict === false) : ordered
  const base = `/${workspace}/scorecard/${encodeURIComponent(id)}`

  // Trace sink export results — jump via per-case external deep link (trace detail on the observability platform).
  const exportByCase = new Map((record.export?.cases ?? []).map((c) => [c.caseId, c]))

  // Case drilldown: child runs this scorecard fanned out (if any) → caseId→runId. Old/ingest scorecards have no children, so an empty map.
  // Fetched when there are results (completed-case drilldown), while the batch is live (in-flight cases → watch-live
  // links), or when the progress timeline names cases (a terminal-failed batch can have case steps but no results —
  // the step's run link is then the only door to that case's execution detail).
  const childRunByCase = new Map<string, string>()
  // 트라이얼 배치는 한 caseId 에 자식 run 이 여러 개다 — 디스패치 순서(createdAt asc)의 run id 목록을
  // 케이스별로 들고, 아래에서 결과 행의 등장 순번(=트라이얼 순번)과 짝지어 각 행이 제 run 으로 간다.
  const childRunsByCase = new Map<string, string[]>()
  let liveCases: { caseId: string; runId: string; status: RunStatus }[] = []
  if (results.length > 0 || live || steps.some((s) => s.caseId !== undefined)) {
    try {
      const children = runsSchema.parse(await controlPlane.listRuns(ctx, { scorecardId: id }))
      for (const c of children) childRunByCase.set(c.caseId, c.id)
      for (const c of [...children].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        const list = childRunsByCase.get(c.caseId)
        if (list) list.push(c.id)
        else childRunsByCase.set(c.caseId, [c.id])
      }
      // 실행 중(queued/running)인 케이스 — 그 run 상세 페이지가 실행 중 화면·로그를 라이브로 스트리밍한다.
      liveCases = children
        .filter((c) => c.status === 'queued' || c.status === 'running')
        .map((c) => ({ caseId: c.caseId, runId: c.id, status: c.status }))
    } catch {
      // Child run lookup fails/missing → render without drilldown links (keep current behavior)
    }
  }

  // Runner health for self-hosted case failures — a no_runner case names its runner (failure.runnerId); map it to the
  // roster (the workspace roster includes personal runners) so a failed case can show whether that runner is online.
  // Also fetched when the batch's runtime names a specific self-hosted runner (self:<id> / self:ws:<id>) so we can show
  // its friendly device name instead of the raw id. Bare pools (self / self:ws) carry no id, so they need no lookup.
  const runtimeNeedsRoster =
    record.runtime !== undefined &&
    record.runtime.startsWith('self:') &&
    record.runtime !== 'self:ws'
  const runnerById = new Map<string, RunnerMeta>()
  if (
    runtimeNeedsRoster ||
    results.some((r) => r.failure?.runnerId && r.failure.runnerId !== '*')
  ) {
    try {
      const roster = runnersResponseSchema.parse(await controlPlane.listWorkspaceRunners(ctx))
      for (const m of roster.runners) runnerById.set(m.id, m)
    } catch {
      // roster fetch failed → no live badge; the static hint still renders
    }
  }
  // Re-run choices — the re-run dialog lets the viewer adjust the two run-config choices made at submit time (the
  // selected judges + the execution runtime), pre-filled from this batch. Fetch the pickable judges/runtimes/runners
  // only for a terminal batch the viewer can re-run (all optional — a failed fetch just narrows the picker, the
  // original selection is still reproduced).
  const canRun = !live && can(principal?.roles, 'scorecards:run')
  let judgeChoices: JudgePickerChoice[] = []
  let runtimeChoices: { id: string }[] = []
  let myRunners: { id: string; label: string }[] = []
  let hasWorkspaceRunners = false
  if (canRun) {
    try {
      judgeChoices = judgesSchema.parse(await controlPlane.listJudges(ctx))
    } catch {
      // Judge list failed → the dialog keeps the original judges, it just can't add new ones
    }
    try {
      runtimeChoices = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
    } catch {
      // Runtime list failed → the dialog keeps the original runtime, it just can't switch registered runtimes
    }
    try {
      myRunners = runnersResponseSchema.parse(await controlPlane.listRunners(ctx)).runners
    } catch {
      // Runner list failed → the dialog omits personal-runner options
    }
    try {
      hasWorkspaceRunners =
        runnersResponseSchema.parse(await controlPlane.listWorkspaceRunners(ctx)).runners.length > 0
    } catch {
      // Roster failed → the dialog hides the shared team-runner pool option
    }
  }
  const locale = await getLocale()
  const timeZone = await getTimeZone()
  const runnerOnline = (lastSeenAt?: string) =>
    !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < 90_000

  // "이 케이스가 무엇이었는가" — 케이스 상세 다이얼로그가 과제 본문(데이터셋 케이스 정의)으로 답한다.
  // 보조 정보라 실패해도 상세는 그대로 선다(정체 섹션만 빠진다); 트레이스 평가는 데이터셋이 없다.
  let datasetCaseById = new Map<string, DatasetCase>()
  if (results.length > 0 && !isTraceEvaluation(record)) {
    try {
      const dataset = datasetSchema.parse(
        await controlPlane.getDataset(ctx, record.dataset.id, record.dataset.version)
      )
      datasetCaseById = new Map(dataset.cases.map((c) => [c.id, c]))
    } catch {
      // dataset fetch failed → rows/dialog render without the case identity section
    }
  }

  // self-hosted 러너 실패 힌트 — 로스터 조회·로케일은 서버의 일이므로 문장까지 만들어 뷰에 싣는다.
  const runnerHintFor = (failure?: { runnerId?: string }): string | undefined => {
    const rid = failure?.runnerId
    if (!rid) return undefined
    const meta = rid !== '*' ? runnerById.get(rid) : undefined
    if (!meta) return t('failedOnRunnerHint')
    if (runnerOnline(meta.lastSeenAt)) return t('failedOnRunnerOnline', { label: meta.label })
    return t('failedOnRunnerOffline', {
      label: meta.label,
      ago: meta.lastSeenAt ? fmtTimeAgo(meta.lastSeenAt, locale, timeZone) : t('runnerNeverSeen'),
    })
  }

  // 트라이얼 배치의 행 정체성 — 같은 caseId 가 결과에 여러 번(트라이얼마다 한 행) 등장하므로, 레코드의
  // 원본 results 순서(=디스패치 순서) 기준 등장 순번이 그 행의 트라이얼 순번이자 유일 키의 재료다.
  // 필터/정렬(shown)과 무관하게 원본 순서로 세므로 ?case= 딥링크가 필터를 바꿔도 같은 행을 가리킨다.
  const occurrenceByResult = new Map<(typeof results)[number], number>()
  const trialTotals = new Map<string, number>()
  for (const r of results) {
    const n = trialTotals.get(r.caseId) ?? 0
    occurrenceByResult.set(r, n)
    trialTotals.set(r.caseId, n + 1)
  }

  // 케이스 탐색기(컴팩트 행 + 상세 다이얼로그)에 넘길 직렬화된 케이스 뷰 — 정렬·필터가 끝난 shown 순서
  // 그대로라 다이얼로그의 prev/next 가 목록과 같은 순서로 걷는다.
  const caseViews: ScorecardCaseView[] = shown.map(({ r, verdict }) => {
    const datasetCase = datasetCaseById.get(r.caseId)
    const occurrence = occurrenceByResult.get(r) ?? 0
    const trialTotal = trialTotals.get(r.caseId) ?? 1
    // 트라이얼 순번과 자식 run 을 짝짓는다(디스패치 순서 정렬). 수가 안 맞으면(재시도 등) 마지막 run 으로
    // 물러난다 — 이전의 caseId→마지막 run 단일 매핑과 같은 보수적 폴백.
    const runList = childRunsByCase.get(r.caseId) ?? []
    const runId = runList.length === trialTotal ? runList[occurrence] : runList[runList.length - 1]
    const exportCase = exportByCase.get(r.caseId)
    const screenshotSrc = osUseShotSrc(r.snapshot)
    const runnerHint = runnerHintFor(r.failure)
    return {
      key: trialTotal > 1 ? `${r.caseId}#${occurrence + 1}` : r.caseId,
      caseId: r.caseId,
      ...(trialTotal > 1 ? { trial: occurrence + 1, occurrence } : { occurrence }),
      ...(verdict !== undefined ? { verdict } : {}),
      ...(r.verdictBasis !== undefined
        ? {
            verdictBasis: {
              authority: r.verdictBasis.authority,
              aggregation: r.verdictBasis.aggregation,
              deciders: r.verdictBasis.deciders.map((d) => ({
                metric: d.metric,
                graderId: d.graderId,
                pass: d.pass,
              })),
            },
          }
        : {}),
      scores: r.scores.map((s) => ({
        graderId: s.graderId,
        metric: s.metric,
        value: s.value,
        ...(s.pass !== undefined ? { pass: s.pass } : {}),
        ...(s.label !== undefined ? { label: s.label } : {}),
        ...(s.detail !== undefined ? { detail: s.detail } : {}),
        ...(s.status !== undefined ? { status: s.status } : {}),
        ...(s.reason !== undefined ? { reason: s.reason } : {}),
      })),
      ...(runId !== undefined ? { runId } : {}),
      ...(exportCase?.url !== undefined && record.export !== undefined
        ? { exportUrl: exportCase.url, sinkKind: record.export.sink }
        : {}),
      ...(r.snapshot !== undefined
        ? {
            snapshot: {
              kind: String(r.snapshot.kind),
              ...(screenshotSrc !== undefined ? { screenshotSrc } : {}),
              ...(r.snapshot.kind === 'browser' && r.snapshot.url !== undefined
                ? { url: r.snapshot.url }
                : {}),
              // dev 인메모리 스토어의 memory:// ref 는 브라우저가 못 여니 http(s)만 싣는다 (기존 게이트 유지).
              ...(r.snapshot.kind === 'browser' &&
              r.snapshot.domRef !== undefined &&
              /^https?:\/\//.test(r.snapshot.domRef)
                ? { domRef: r.snapshot.domRef }
                : {}),
            },
          }
        : {}),
      errors: (r.trace ?? [])
        .filter(
          (e): e is typeof e & { message: string } =>
            e.kind === 'error' && typeof e.message === 'string'
        )
        .map((e) => e.message),
      ...(runnerHint !== undefined ? { runnerHint } : {}),
      hasTrace: (r.trace ?? []).length > 0,
      ...(datasetCase !== undefined
        ? {
            task: datasetCase.task,
            ...(datasetCase.env?.kind !== undefined ? { envKind: datasetCase.env.kind } : {}),
            graderIds: datasetCase.graders.map((g) => g.id),
            tags: datasetCase.tags,
            ...(datasetCase.timeoutSec !== undefined ? { timeoutSec: datasetCase.timeoutSec } : {}),
          }
        : {}),
    }
  })
  const caseViewIds = new Set(caseViews.map((c) => c.caseId))

  return (
    // @container: 아래 그리드들은 뷰포트가 아니라 이 컬럼의 폭에 반응한다 — 인프라 패널이 열리면
    // 뷰포트는 넓어도 이 컬럼은 ~500px 로 좁아지므로, run 상세와 같은 컨테이너 쿼리 기준을 쓴다.
    <div className="@container space-y-7">
      {/* In progress: periodically re-run the server component to live-update steps (stops once terminal). */}
      <AutoRefresh enabled={live} />
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader
          title={<span className="font-mono">scorecard {record.id.slice(0, 8)}</span>}
          description={
            isTraceEvaluation(record)
              ? t('traceEvaluation')
              : `${record.dataset.id}@${record.dataset.version} → ${record.harness.id}@${record.harness.version}`
          }
          actions={
            // 액션이 많은 상세라(다운로드·재실행·삭제·상태 필) 좁은 컬럼에서는 줄바꿈으로 살아남는다.
            <div className="flex flex-wrap items-center justify-end gap-2">
              <MentionInChatButton
                reference={{ type: 'scorecard', id: record.id, label: record.id.slice(0, 8) }}
                mission="scorecardAnalyze"
              />
              {/* Download the self-contained analysis artifact (summary + per-case verdict/scores) through OUR OWN
                  route — never `record.analysisRef` itself: that ref is the object store's presigned URL, which
                  carries the SERVER-internal endpoint (http://minio:9000 → an outside browser can't resolve it) and
                  expires within the hour. The BFF asks the control plane, which reads the artifact by key. The link
                  still appears only when the record HAS an offloaded artifact. */}
              {record.analysisRef && (
                <a
                  href={`/api/scorecards/${encodeURIComponent(record.id)}/analysis`}
                  download={`scorecard-${record.id}-analysis.json`}
                  className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                >
                  <Download />
                  {t('downloadAnalysis')}
                </a>
              )}
              {/* Stop is offered only while the batch is live and the viewer can run scorecards. */}
              {live && can(principal?.roles, 'scorecards:run') && (
                <StopScorecardButton id={record.id} />
              )}
              {/* Re-run is offered once the batch is terminal, to a viewer who can run scorecards — one button that
                  chooses between a full re-run (every case, optionally re-scored) and a failed-only recovery
                  (passing cases carry over). The control plane enforces scorecards:run. */}
              {/* Targeted recovery of transient judge blips — shown only when the served detail says a
                  retryable-unmeasured worklist exists. In-place, no case re-runs; distinct from re-run/retry. */}
              {canRun &&
                record.retryableUnmeasured !== undefined &&
                record.retryableUnmeasured > 0 && (
                  <RescoreScorecardButton id={record.id} count={record.retryableUnmeasured} />
                )}
              {canRun && (
                <RerunScorecardButton
                  id={record.id}
                  workspace={workspace}
                  failedCount={failedCount}
                  originalJudges={judges}
                  originalRuntime={record.runtime}
                  judges={judgeChoices}
                  runtimes={runtimeChoices}
                  runners={myRunners}
                  hasWorkspaceRunners={hasWorkspaceRunners}
                />
              )}
              {/* Delete is offered once the batch is terminal, to its creator or a workspace admin (mirrors the
                  harness/dataset delete UX; the control plane enforces scorecards:delete + the creator exception). */}
              {!live &&
                (can(principal?.roles, 'scorecards:delete') ||
                  (record.createdBy !== undefined && record.createdBy === principal?.subject)) && (
                  <DeleteScorecardButton
                    id={record.id}
                    dataset={record.dataset}
                    harness={record.harness}
                    workspace={workspace}
                  />
                )}
              <StatusPill status={record.status} />
            </div>
          }
        />
      </div>

      {/* 실행 중인 케이스 (라이브) — 지금 실행 중인 자식 run들. 열면 실행 중 화면(browser-use 크롬 등)·로그를 라이브로 볼 수 있다. */}
      {live && liveCases.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader
            title={t('liveCasesTitle')}
            action={<InfoTip content={t('liveCasesHint')} />}
          />
          <div className="space-y-2">
            {liveCases.map((c) => (
              <Card key={c.runId} className="flex items-center justify-between gap-3 p-3.5">
                <span className="flex min-w-0 items-center gap-2">
                  <StatusPill status={c.status} />
                  <span className="truncate font-mono text-[13px] font-[510]">{c.caseId}</span>
                </span>
                <Link
                  href={`/${workspace}/run/${encodeURIComponent(c.runId)}`}
                  className="shrink-0 font-mono text-[12px] text-link transition-colors hover:text-foreground"
                >
                  {t('watchLive')} →
                </Link>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Case rollup — the headline result of this run (pass/fail at a glance). Only when there are results. */}
      {results.length > 0 && (
        <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
          <StatCard
            label={t('statCases')}
            value={results.length}
            hint={
              record.subset
                ? `${t('subsetPartial', { total: record.subset.total })}${skipped > 0 ? ` · ${t('subsetSkipped', { n: skipped })}` : ''}`
                : skipped > 0
                  ? t('subsetSkipped', { n: skipped })
                  : undefined
            }
          />
          <StatCard
            label={t('statPassed')}
            value={passed}
            tone={passed > 0 ? 'success' : 'default'}
          />
          <StatCard
            label={t('statFailed')}
            value={failedCount}
            tone={failedCount > 0 ? 'danger' : 'default'}
          />
          <StatCard
            label={t('statPassRate')}
            value={passRate == null ? '–' : fmtPct(passRate)}
            tone={
              passRate == null
                ? 'default'
                : passRate >= 0.75
                  ? 'success'
                  : passRate >= 0.4
                    ? 'default'
                    : 'danger'
            }
          />
        </div>
      )}

      {/* Trials — pass@k / flakiness roll-up (only when this batch ran repeated trials per case). */}
      {record.trialSummary && (
        <section className="space-y-2.5">
          <SectionHeader title={t('trialsTitle')} action={<InfoTip content={t('trialsInfo')} />} />
          <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
            <StatCard
              label={t('trialsPassAt1')}
              value={fmtPct(record.trialSummary.passAt1)}
              tone={rateTone(record.trialSummary.passAt1)}
            />
            <StatCard
              label={t('trialsPassAtK', { k: record.trialSummary.k })}
              value={fmtPct(record.trialSummary.passAtK)}
              tone={rateTone(record.trialSummary.passAtK)}
            />
            <StatCard
              label={t('trialsFlakeRate')}
              value={fmtPct(record.trialSummary.flakeRate)}
              tone={record.trialSummary.flakyCases > 0 ? 'danger' : 'success'}
              hint={t('trialsFlakyCases', {
                n: record.trialSummary.flakyCases,
                total: record.trialSummary.cases,
              })}
            />
            <StatCard
              label={t('trialsPerCase')}
              value={
                record.trialSummary.minTrials === record.trialSummary.maxTrials
                  ? record.trialSummary.minTrials
                  : `${record.trialSummary.minTrials}–${record.trialSummary.maxTrials}`
              }
            />
          </div>
        </section>
      )}

      <Card className="grid grid-cols-2 gap-4 p-4 @2xl:grid-cols-4">
        {/* dataset · harness · judge are real entities — shown as their chip (icon + id@version), linking to the entity
            detail. A trace evaluation (no dataset / no harness run) carries the reserved sentinel for both, so show a
            single "Trace evaluation" label instead of two deep-links that would 404. */}
        {isTraceEvaluation(record) ? (
          <MetaItem label={t('sourceMeta')}>
            <span className="text-[13px] font-[510]">{t('traceEvaluation')}</span>
          </MetaItem>
        ) : (
          <>
            <MetaItem label="dataset">
              <EntityMetaLink
                href={`/${workspace}/dataset/${encodeURIComponent(record.dataset.id)}?version=${encodeURIComponent(record.dataset.version)}`}
              >
                <EntityRef id={record.dataset.id} version={record.dataset.version} kind="dataset" />
              </EntityMetaLink>
            </MetaItem>
            <MetaItem label="harness">
              <EntityMetaLink
                href={`/${workspace}/harness/${encodeURIComponent(record.harness.id)}?v=${encodeURIComponent(record.harness.version)}`}
              >
                <EntityRef id={record.harness.id} version={record.harness.version} kind="harness" />
              </EntityMetaLink>
            </MetaItem>
          </>
        )}
        {/* The Agent Judge(s) that scored this batch — each links to its detail page (detail resolves the latest version). */}
        {judges.length > 0 && (
          <MetaItem label="judge">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {judges.map((j) => (
                <EntityMetaLink
                  key={`${j.id}@${j.version}`}
                  href={`/${workspace}/judge/${encodeURIComponent(j.id)}`}
                >
                  <EntityRef id={j.id} version={j.version} kind="judge" />
                </EntityMetaLink>
              ))}
            </div>
          </MetaItem>
        )}
        {/* The runtime this batch ran on — shown by name (a self-hosted runner's device name, resolved from the roster).
            Only a registered runtime links to its detail page; self-hosted runners show the name only (multi-tenant —
            a batch may have run on another member's personal runner, which has no screen to navigate to). Hidden if
            unset (legacy · ingest). */}
        {record.runtime &&
          (() => {
            const rd = runtimeDisplay(record.runtime, {
              workspace,
              runnerLabelOf: (rid) => runnerById.get(rid)?.label,
              poolPersonalLabel: t('runtimePoolPersonal'),
              poolWorkspaceLabel: t('runtimePoolWorkspace'),
            })
            return (
              <MetaItem label={t('metaRuntime')}>
                {rd.href ? (
                  <Link
                    href={rd.href}
                    className="rounded-sm hover:underline"
                    title={t('runtimeDetailTitle')}
                  >
                    <RuntimeChip label={rd.label} />
                  </Link>
                ) : (
                  <RuntimeChip label={rd.label} />
                )}
              </MetaItem>
            )
          })()}
        {/* Trigger provenance (origin/출처) — CI/schedule/API/web + commit · PR · CI run links, folded into the meta card. */}
        {record.origin && (
          <MetaItem label={t('metaSource')}>
            <OriginInline origin={record.origin} />
          </MetaItem>
        )}
        <Prop
          label="created"
          value={new Date(record.createdAt).toLocaleString(undefined, { timeZone })}
        />
        <Prop
          label="updated"
          value={new Date(record.updatedAt).toLocaleString(undefined, { timeZone })}
        />
        {/* Duration (소요시간) — wall-clock from submit (createdAt) to completion (updatedAt). While the batch is
            still live there is no end yet, so show the elapsed-so-far (the page auto-refreshes, so it ticks up). */}
        <Prop
          label={t('metaDuration')}
          value={
            live
              ? t('durationRunning', {
                  elapsed: fmtElapsed(record.createdAt, new Date().toISOString()),
                })
              : fmtElapsed(record.createdAt, record.updatedAt)
          }
        />
        {authorName && <Prop label={t('metaRunBy')} value={authorName} />}
        <MetaItem label={t('metaTeam')}>
          <TeamOwnerControl
            kind="scorecards"
            id={record.id}
            {...(record.teamId !== undefined ? { teamId: record.teamId } : {})}
            teams={teamMove.teams}
            writableIds={teamMove.writableIds}
            showLabel={false}
          />
        </MetaItem>
        {/* Temporal-owned batch — the durable workflow's id; deep-links to the Temporal UI when TEMPORAL_UI_URL is set. */}
        {record.orchestration?.workflowId && (
          <MetaItem label={t('metaWorkflow')}>
            <span className="block truncate font-mono text-[13px] text-foreground">
              {temporalUiBase ? (
                <a
                  href={`${temporalUiBase}/namespaces/default/workflows/${encodeURIComponent(record.orchestration.workflowId)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-sm hover:underline"
                >
                  {record.orchestration.workflowId}
                </a>
              ) : (
                record.orchestration.workflowId
              )}
            </span>
          </MetaItem>
        )}
        {record.subset && (
          <Prop
            label={t('metaSubset')}
            value={`${record.subset.selected}/${record.subset.total}${(() => {
              const parts = [
                record.subset.ids ? t('subsetIds', { n: record.subset.ids.length }) : undefined,
                record.subset.tags
                  ? t('subsetTags', { tags: record.subset.tags.join(', ') })
                  : undefined,
                record.subset.limit !== undefined ? `limit ${record.subset.limit}` : undefined,
              ].filter(Boolean)
              return parts.length > 0 ? ` — ${parts.join(' · ')}` : ''
            })()}`}
          />
        )}
        {/* CI PR ephemeral pins (slot→image) — a full-width sub-row of the same meta card (origin's detail, not a separate block). */}
        {record.origin && Object.keys(record.origin.pinOverrides ?? {}).length > 0 && (
          <div className="col-span-2 @2xl:col-span-4">
            <OriginPins origin={record.origin} />
          </div>
        )}
      </Card>

      {/* Trace sink export — signals that the detailed results live on the team's observability platform and gives a shortcut (unset records are hidden entirely). */}
      {record.export && (
        <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">
              {t('traceSinkLabel')}
            </span>
            {/* Sink registration name first (if any), kind as a secondary badge — just kind alone if no name. */}
            <Badge tone="neutral">{record.export.name ?? record.export.sink}</Badge>
            {record.export.name && <Badge tone="neutral">{record.export.sink}</Badge>}
            <Badge
              tone={
                record.export.status === 'succeeded'
                  ? 'success'
                  : record.export.status === 'partial'
                    ? 'warning'
                    : 'danger'
              }
            >
              {record.export.status === 'succeeded'
                ? t('exportSucceeded')
                : record.export.status === 'partial'
                  ? t('exportPartial')
                  : t('exportFailed')}
            </Badge>
          </div>
          {record.export.url && (
            <a
              href={record.export.url}
              target="_blank"
              rel="noreferrer"
              className="text-[12px] font-[510] text-link transition-colors hover:text-foreground"
            >
              {t('exportViewOnPlatform')}
            </a>
          )}
          {record.export.message && (
            <span className="text-[12px] text-muted-foreground">{record.export.message}</span>
          )}
        </Card>
      )}

      {(record.models?.primary ||
        (record.models?.observed.length ?? 0) > 0 ||
        (record.judgeModels?.length ?? 0) > 0) && (
        <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
          {record.models && (record.models.primary || record.models.observed.length > 0) && (
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">
                model
              </span>
              <ModelChip>{record.models.primary ?? 'unknown'}</ModelChip>
            </div>
          )}
          {record.models && record.models.observed.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">{t('modelsObserved')}</span>
              {record.models.observed.map((m) => (
                <ModelChip key={m} muted>
                  {m}
                </ModelChip>
              ))}
            </div>
          )}
          {record.models?.declared && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">{t('modelsDeclared')}</span>
              <ModelChip muted>{record.models.declared}</ModelChip>
              {record.models.primary && record.models.declared !== record.models.primary && (
                <Badge tone="danger">{t('modelsMismatch')}</Badge>
              )}
            </div>
          )}
          {record.judgeModels && record.judgeModels.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">judge</span>
              {record.judgeModels.map((jm) => (
                <ModelChip key={jm} muted>
                  {jm}
                </ModelChip>
              ))}
            </div>
          )}
        </Card>
      )}

      {record.error && (
        <Callout tone="danger" hint={record.error.message}>
          {record.error.phase
            ? t('phaseFailure', { code: record.error.code, phase: record.error.phase })
            : record.error.code}
        </Callout>
      )}

      {/* 케이스를 여는 문(타임라인 스텝 칩 · 케이스 행)이 하나의 상세 다이얼로그를 공유한다 — ?case= 딥링크 포함. */}
      <ScorecardCasesProvider
        workspace={workspace}
        scorecardId={record.id}
        cases={caseViews}
        initialCaseId={caseParam}
      >
        {(steps.length > 0 || live) && (
          <section className="space-y-2.5">
            <SectionHeader
              title={t('stepsTitle')}
              action={live ? <Badge tone="neutral">{t('liveRefreshing')}</Badge> : undefined}
            />
            {steps.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('preparingRun')}</p>
            ) : (
              <Card className="divide-y divide-border">
                {steps.map((s, i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-2.5">
                    <span
                      className={cn(
                        'mt-[7px] size-1.5 shrink-0 rounded-full',
                        s.status === 'failed'
                          ? 'bg-destructive'
                          : s.status === 'ok'
                            ? 'bg-[var(--color-success)]'
                            : s.status === 'started'
                              ? 'animate-pulse bg-link'
                              : 'bg-muted-foreground'
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <span className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">
                        {s.phase}
                      </span>
                      {/* Per-case progress step (judge verdict etc.): a case WITH a result opens the case detail
                        dialog in place (task + agent trace + judge evaluation on one screen); a case step with
                        no result yet (terminal-failed batch) keeps the child-run link as its only door. */}
                      {s.caseId &&
                        (caseViewIds.has(s.caseId) ? (
                          <OpenCaseChip caseId={s.caseId} />
                        ) : (
                          childRunByCase.get(s.caseId) && (
                            <Link
                              href={`/${workspace}/run/${childRunByCase.get(s.caseId)}`}
                              className="ml-2 font-mono text-[11px] text-link transition-colors hover:text-foreground"
                            >
                              → run
                            </Link>
                          )
                        ))}
                      {/* Long failure reasons (the whole error is carried now, not cut at 140) stay a few lines with an
                        expand toggle so one erroring case doesn't blow up the timeline; short steps show no toggle. */}
                      <ExpandableText
                        text={s.message}
                        className={cn(
                          'break-words text-[13px] leading-relaxed',
                          s.status === 'failed' ? 'text-destructive' : 'text-foreground'
                        )}
                      />
                    </div>
                    <time className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-faint">
                      {new Date(s.ts).toLocaleTimeString(undefined, { timeZone })}
                    </time>
                  </div>
                ))}
              </Card>
            )}
          </section>
        )}

        <section className="space-y-2.5">
          <SectionHeader title={t('metricsSummaryTitle')} />
          {summary.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('noSummary')}</p>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>metric</TH>
                  <TH>value</TH>
                  <TH className="text-right">n</TH>
                </tr>
              </THead>
              <TBody>
                {/* Multi-criteria judges: the overall row first, its criterion metrics indented beneath (stable order). Non-judge metrics unchanged. */}
                {groupMetricRows(summary).flatMap((g) => [
                  <TR key={g.row.metric}>
                    <TD className="text-[12px] font-[510]">
                      <MetricLabel metric={g.row.metric} siblings={summaryMetrics} />
                    </TD>
                    <SummaryCells m={g.row} unmeasuredLabel={t('scoreUnmeasured')} />
                  </TR>,
                  ...g.criteria.map((c) => (
                    <TR key={c.row.metric}>
                      <TD className="text-[12px]">
                        <span
                          title={c.row.metric}
                          className="inline-flex min-w-0 items-center gap-1.5 pl-5"
                        >
                          <span className="text-faint">└</span>
                          <CriterionBadge
                            criterionId={
                              c.parsed.kind === 'judge-criterion'
                                ? c.parsed.criterionId
                                : c.row.metric
                            }
                          />
                        </span>
                      </TD>
                      <SummaryCells m={c.row} unmeasuredLabel={t('scoreUnmeasured')} />
                    </TR>
                  )),
                ])}
              </TBody>
            </Table>
          )}
        </section>

        <section id="cases" className="scroll-mt-6 space-y-2.5">
          <SectionHeader
            title={t('casesTitle', { count: results.length })}
            action={
              failedCount > 0 ? (
                <div className="inline-flex overflow-hidden rounded-md border">
                  <CaseFilterTab href={`${base}#cases`} active={filter === 'all'}>
                    {t('filterAll', { n: results.length })}
                  </CaseFilterTab>
                  <CaseFilterTab
                    href={`${base}?cases=failed#cases`}
                    active={filter === 'failed'}
                    danger
                  >
                    {t('filterFailed', { n: failedCount })}
                  </CaseFilterTab>
                </div>
              ) : results.length > 0 ? (
                <Badge tone="success">{t('allPassed')}</Badge>
              ) : undefined
            }
          />
          {/* Case-fate denominators — shown whenever the funnel is lossy (infra failures, unmeasured, cancelled,
            or unlaunched requested cases), so the pass count is never silently read against the wrong
            denominator (841/970 vs 841/1000 are different claims). */}
          {record.outcomes &&
            (record.outcomes.infraFailed > 0 ||
              record.outcomes.unmeasured > 0 ||
              record.outcomes.cancelled > 0 ||
              (record.outcomes.requested ?? record.outcomes.executed) >
                record.outcomes.executed) && (
              <p className="text-[12px] text-muted-foreground">
                {t('caseOutcomesStrip', {
                  executed: record.outcomes.executed,
                  verdicted: record.outcomes.verdicted,
                  passed: record.outcomes.passed,
                  failed: record.outcomes.failed,
                  infraFailed: record.outcomes.infraFailed,
                  unmeasured: record.outcomes.unmeasured,
                })}
              </p>
            )}
          {results.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {record.status === 'failed'
                ? t('noCasesFailed')
                : record.status === 'running' || record.status === 'queued'
                  ? t('noCasesRunning')
                  : t('noCasesGeneric')}
            </p>
          ) : (
            // 한 케이스 = 한 줄 (판정 · id · 과제 한 줄 · overall 배지). 근거 전부(스크린샷·리즈닝·에러·criterion)는
            // 클릭해 여는 케이스 상세 다이얼로그의 것 — 목록이 모든 케이스의 모든 근거를 펼치던 이전 카드의 교체.
            <ScorecardCaseList />
          )}
        </section>
      </ScorecardCasesProvider>

      <CommentsSection
        workspace={workspace}
        resourceType="scorecard"
        resourceId={id}
        title={t('discussTitle')}
      />
    </div>
  )
}
