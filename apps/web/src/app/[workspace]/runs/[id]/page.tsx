import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { LiveLogs } from '@/widgets/live-logs'
import { ReplayPlayer } from '@/widgets/replay-player'
import { LiveScreen, SandboxTerminal } from '@/widgets/sandbox-terminal'
import { TraceTimeline } from '@/widgets/trace-timeline'
import { CommentsSection } from '@/features/discuss'
import { membersSchema } from '@/entities/member'
import { runSchema, type Run } from '@/entities/run'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtScoreDetail, fmtSubject, fmtTokens, fmtUsd } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { RuntimeChip } from '@/shared/ui/chip'
import { MetricLabel } from '@/shared/ui/metric-label'
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
  try {
    run = runSchema.parse(await controlPlane.getRun(ctx, id))
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

  const scores = run.result?.scores ?? []
  const trace = run.result?.trace ?? []
  const snapshot = run.result?.snapshot
  const usage = run.usage

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

  return (
    <div className="space-y-7">
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
              {/* 재생 가능한 run이면 "리플레이" 배지 → 아래 #replay 섹션으로 점프(발견성). agent trace만 있어도
                  재생되므로(하네스 무관) recordingRef 없이 trace만으로도 노출한다. */}
              {hasReplay && (
                <a href="#replay" className="no-underline">
                  <Badge tone="info">{t('replay')}</Badge>
                </a>
              )}
              <StatusPill status={run.status} />
            </div>
          }
        />
      </div>

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Prop label="harness" value={`${run.harness.id}@${run.harness.version}`} />
        <Prop label="case" value={run.caseId} />
        {/* Runtime (where it ran) — registered runtime links out; a self-hosted runner shows a label only. Hidden if unset (legacy / default backend). */}
        {runtime && (
          <MetaItem label={t('metaRuntime')}>
            {runtimeIsSelfHosted ? (
              <RuntimeChip label={t('runtimeSelfHosted')} />
            ) : (
              <Link
                href={`/${workspace}/runtimes/${encodeURIComponent(runtime)}`}
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
              href={`/${workspace}/scorecards/${encodeURIComponent(run.parentScorecardId)}`}
              className="inline-flex items-center gap-1 font-mono text-[13px] text-link transition-colors hover:text-foreground"
            >
              {run.parentScorecardId.slice(0, 8)} →
            </Link>
          </MetaItem>
        )}
      </Card>

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
          {/* 라이브 화면 — browser(browser-use 등)/os-use 케이스면 실행 중 화면을 CDP/scrot/러너-푸시 프레임으로
              2초마다 폴링; 라이브 화면이 없는 run이면 위젯이 self-null (빈 섹션 없음) */}
          <LiveScreen runId={run.id} initialStatus={run.status} />
          <div className="space-y-2.5">
            <SectionHeader title={t('liveLogs')} />
            <Card className="p-4">
              <LiveLogs runId={run.id} initialStatus={run.status} />
            </Card>
          </div>
          {/* 샌드박스 터미널 — 실행 중인 케이스 컨테이너로 한 번씩 exec (creator/admin, 컨트롤플레인이 강제) */}
          <div className="space-y-2.5">
            <SectionHeader title={t('sandbox')} />
            <Card className="p-4">
              <SandboxTerminal runId={run.id} />
            </Card>
          </div>
        </section>
      )}

      {/* 리플레이 — 종료된 run의 앵커 섹션. agent trace(모든 하네스 공통)를 벽시계로 스크럽하고, 녹화 프레임이
          있으면 그 시점 화면을 오버레이한다. 헤더 "리플레이" 배지가 여기로 점프한다. docs/architecture/replay.md */}
      {hasReplay && (
        <div id="replay" className="scroll-mt-6">
          <ReplayPlayer runId={run.id} initialStatus={run.status} trace={trace} />
        </div>
      )}

      <section className="space-y-2.5">
        <SectionHeader title={t('scores')} />
        {scores.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('noScores')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {/* key includes the metric — a multi-criteria judge emits several scores under one graderId. */}
            {scores.map((s) => {
              const detailText = fmtScoreDetail(s.detail)
              return (
                <Card key={`${s.graderId}:${s.metric}`} className="p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[13px] font-[510]">{s.graderId}</span>
                    {s.pass != null && (
                      <Badge tone={s.pass ? 'success' : 'danger'} className="shrink-0">
                        {s.pass ? 'pass' : 'fail'}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1.5 break-words font-mono text-2xl font-[560] tabular-nums tracking-tight">
                    {s.value}
                  </div>
                  <div className="text-[12px] text-faint">
                    <MetricLabel metric={s.metric} siblings={scores.map((x) => x.metric)} />
                  </div>
                  {/* Verdict reasoning (judge rubric reasoning, command output, etc.) — shows the "why" in os-use VLM grading. */}
                  {detailText && (
                    <p className="mt-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-muted-foreground">
                      {detailText}
                    </p>
                  )}
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <section className="space-y-2.5">
        <SectionHeader title={t('trace')} />
        <Card className="p-4">
          <TraceTimeline trace={trace} />
        </Card>
      </section>

      {snapshot && (
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
              </div>
            )}
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-[12px] text-muted-foreground">
              {JSON.stringify(
                { ...snapshot, screenshot: snapshot.screenshot ? '<base64>' : undefined },
                null,
                2
              )}
            </pre>
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
