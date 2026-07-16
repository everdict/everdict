import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getLocale, getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import { RetryFailedButton } from '@/features/retry-failed-cases'
import { StopScorecardButton } from '@/features/stop-scorecard'
import { membersSchema } from '@/entities/member'
import { runsSchema, type RunStatus } from '@/entities/run'
import { runnersResponseSchema, type RunnerMeta } from '@/entities/runner'
import {
  scorecardRecordSchema,
  type MetricSummary,
  type ScorecardRecord,
} from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { env } from '@/shared/config/env'
import { controlPlane } from '@/shared/lib/control-plane'
import {
  fmtMetricLabel,
  fmtPct,
  fmtSubject,
  fmtTimeAgo,
  groupMetricRows,
  HEALTH_TEXT,
  rateHealth,
} from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { AutoRefresh } from '@/shared/ui/auto-refresh'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EntityRef, ModelChip, RuntimeChip } from '@/shared/ui/chip'
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
    return { label: target, href: `/${workspace}/runtimes/${encodeURIComponent(target)}` }
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

// Numeric cells of a metric-summary row — shared by judge-overall rows and their indented criterion sub-rows.
function SummaryCells({ m }: { m: MetricSummary }) {
  return (
    <>
      <TD className="text-right font-mono text-[12px] tabular-nums">{m.mean.toFixed(2)}</TD>
      <TD className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
        {m.count}
      </TD>
      <TD className="text-right font-mono text-[12px] tabular-nums">
        {m.passRate == null ? (
          <span className="text-faint">—</span>
        ) : (
          <span className={HEALTH_TEXT[rateHealth(m.passRate)]}>{fmtPct(m.passRate)}</span>
        )}
      </TD>
    </>
  )
}

// Per-case score badge tone — the judge/grader pass verdict (neutral when the score carries no pass).
function scoreTone(pass?: boolean): 'neutral' | 'success' | 'danger' {
  return pass == null ? 'neutral' : pass ? 'success' : 'danger'
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
  searchParams: Promise<{ cases?: string }>
}) {
  const { workspace, id } = await params
  const { cases } = await searchParams
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

  const summary = record.summary ?? []
  const summaryMetrics = summary.map((m) => m.metric) // sibling context for judge-metric disambiguation
  const judges = record.orchestration?.judges ?? [] // Agent Judges applied to this batch → entity links in the meta card
  const results = record.scorecard?.results ?? []
  const steps = record.steps ?? []
  const live = record.status === 'queued' || record.status === 'running'

  // The per-case verdict is server-computed (served field) — shared across rollup · sort · filter.
  const cased = results.map((r) => ({ r, verdict: r.verdict }))
  const passed = cased.filter((c) => c.verdict === true).length
  const failedCount = cased.filter((c) => c.verdict === false).length
  const skipped = cased.filter((c) => c.verdict == null).length
  const passRate = results.length > 0 ? passed / results.length : null

  // Failure-first sort (fail → skip → pass), then failed-only/all filter.
  const filter = cases === 'failed' ? 'failed' : 'all'
  const weight = (v: boolean | undefined) => (v === false ? 0 : v == null ? 1 : 2)
  const ordered = [...cased].sort((a, b) => weight(a.verdict) - weight(b.verdict))
  const shown = filter === 'failed' ? ordered.filter((c) => c.verdict === false) : ordered
  const base = `/${workspace}/scorecards/${encodeURIComponent(id)}`

  // Trace sink export results — jump via per-case external deep link (trace detail on the observability platform).
  const exportByCase = new Map((record.export?.cases ?? []).map((c) => [c.caseId, c]))

  // Case drilldown: child runs this scorecard fanned out (if any) → caseId→runId. Old/ingest scorecards have no children, so an empty map.
  // Fetched when there are results (completed-case drilldown) OR while the batch is live (in-flight cases → watch-live links).
  const childRunByCase = new Map<string, string>()
  let liveCases: { caseId: string; runId: string; status: RunStatus }[] = []
  if (results.length > 0 || live) {
    try {
      const children = runsSchema.parse(await controlPlane.listRuns(ctx, { scorecardId: id }))
      for (const c of children) childRunByCase.set(c.caseId, c.id)
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
  const locale = await getLocale()
  const runnerOnline = (lastSeenAt?: string) =>
    !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < 90_000

  return (
    <div className="space-y-7">
      {/* In progress: periodically re-run the server component to live-update steps (stops once terminal). */}
      <AutoRefresh enabled={live} />
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader
          title={<span className="font-mono">scorecard {record.id.slice(0, 8)}</span>}
          description={`${record.dataset.id}@${record.dataset.version} → ${record.harness.id}@${record.harness.version}`}
          actions={
            <div className="flex items-center gap-2">
              {/* Stop is offered only while the batch is live and the viewer can run scorecards. */}
              {live && can(principal?.roles, 'scorecards:run') && (
                <StopScorecardButton id={record.id} />
              )}
              {/* Retry is offered once the batch is terminal and some cases failed — re-run just those (e.g. after a
                  runner was down) as a new scorecard; passing cases carry over. The control plane enforces scorecards:run. */}
              {!live && failedCount > 0 && (
                <RetryFailedButton id={record.id} workspace={workspace} />
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
                  href={`/${workspace}/runs/${encodeURIComponent(c.runId)}`}
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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        {/* dataset · harness · judge are real entities — shown as their chip (icon + id@version), linking to the entity detail. */}
        <MetaItem label="dataset">
          <EntityMetaLink
            href={`/${workspace}/datasets/${encodeURIComponent(record.dataset.id)}?version=${encodeURIComponent(record.dataset.version)}`}
          >
            <EntityRef id={record.dataset.id} version={record.dataset.version} kind="dataset" />
          </EntityMetaLink>
        </MetaItem>
        <MetaItem label="harness">
          <EntityMetaLink
            href={`/${workspace}/harnesses/${encodeURIComponent(record.harness.id)}?v=${encodeURIComponent(record.harness.version)}`}
          >
            <EntityRef id={record.harness.id} version={record.harness.version} kind="harness" />
          </EntityMetaLink>
        </MetaItem>
        {/* The Agent Judge(s) that scored this batch — each links to its detail page (detail resolves the latest version). */}
        {judges.length > 0 && (
          <MetaItem label="judge">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {judges.map((j) => (
                <EntityMetaLink
                  key={`${j.id}@${j.version}`}
                  href={`/${workspace}/judges/${encodeURIComponent(j.id)}`}
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
        <Prop label="created" value={new Date(record.createdAt).toLocaleString()} />
        <Prop label="updated" value={new Date(record.updatedAt).toLocaleString()} />
        {authorName && <Prop label={t('metaRunBy')} value={authorName} />}
        {/* Temporal-owned batch — the durable workflow's id; deep-links to the Temporal UI when TEMPORAL_UI_URL is set. */}
        {record.orchestration?.workflowId && (
          <MetaItem label={t('metaWorkflow')}>
            <span className="block truncate font-mono text-[13px] text-foreground">
              {env.TEMPORAL_UI_URL ? (
                <a
                  href={`${env.TEMPORAL_UI_URL}/namespaces/default/workflows/${encodeURIComponent(record.orchestration.workflowId)}`}
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
          <div className="col-span-2 sm:col-span-4">
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
                    <p
                      className={cn(
                        'break-words text-[13px] leading-relaxed',
                        s.status === 'failed' ? 'text-destructive' : 'text-foreground'
                      )}
                    >
                      {s.message}
                    </p>
                  </div>
                  <time className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-faint">
                    {new Date(s.ts).toLocaleTimeString()}
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
                <TH className="text-right">mean</TH>
                <TH className="text-right">n</TH>
                <TH className="text-right">pass rate</TH>
              </tr>
            </THead>
            <TBody>
              {/* Multi-criteria judges: the overall row first, its criterion metrics indented beneath (stable order). Non-judge metrics unchanged. */}
              {groupMetricRows(summary).flatMap((g) => [
                <TR key={g.row.metric}>
                  <TD className="text-[12px] font-[510]">
                    <MetricLabel metric={g.row.metric} siblings={summaryMetrics} />
                  </TD>
                  <SummaryCells m={g.row} />
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
                    <SummaryCells m={c.row} />
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
        {results.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {record.status === 'failed'
              ? t('noCasesFailed')
              : record.status === 'running' || record.status === 'queued'
                ? t('noCasesRunning')
                : t('noCasesGeneric')}
          </p>
        ) : (
          <div className="space-y-2">
            {shown.map(({ r, verdict }) => {
              // Sibling context of this case's score labels + judge grouping (criteria under their overall).
              const caseMetrics = r.scores.map((s) => s.metric)
              const scoreGroups = groupMetricRows(r.scores)
              return (
                <Card
                  key={r.caseId}
                  className={cn(
                    'space-y-2 border-l-2 p-3.5',
                    verdict === false
                      ? 'border-l-destructive'
                      : verdict == null
                        ? 'border-l-border-strong'
                        : 'border-l-[var(--color-success)]/60'
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="flex items-center gap-2">
                      <Badge tone={verdict == null ? 'neutral' : verdict ? 'success' : 'danger'}>
                        {verdict == null ? 'SKIP' : verdict ? 'PASS' : 'FAIL'}
                      </Badge>
                      <span className="font-mono text-[13px] font-[510]">{r.caseId}</span>
                      {/* This case's child run (if any) — full trace/usage/provenance drilldown. */}
                      {childRunByCase.get(r.caseId) && (
                        <Link
                          href={`/${workspace}/runs/${childRunByCase.get(r.caseId)}`}
                          className="font-mono text-[11px] text-link transition-colors hover:text-foreground"
                        >
                          → run
                        </Link>
                      )}
                      {/* Trace sink deep link (if any) — jump to the original/exported trace on the observability platform. */}
                      {exportByCase.get(r.caseId)?.url && (
                        <a
                          href={exportByCase.get(r.caseId)?.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[11px] text-link transition-colors hover:text-foreground"
                        >
                          → {record.export?.sink} ↗
                        </a>
                      )}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {r.snapshot?.kind && <Badge tone="neutral">{String(r.snapshot.kind)}</Badge>}
                      {r.scores.length === 0 ? (
                        <span className="text-[12px] text-muted-foreground">{t('noScores')}</span>
                      ) : (
                        // A multi-criteria judge's scores stay together: the overall badge boxed with its criterion badges (each with its own pass tone).
                        scoreGroups.map((g) =>
                          g.criteria.length === 0 ? (
                            <Badge
                              key={`${g.row.graderId}:${g.row.metric}`}
                              title={g.row.metric}
                              tone={scoreTone(g.row.pass)}
                            >
                              {fmtMetricLabel(g.row.metric, caseMetrics)} {g.row.value}
                            </Badge>
                          ) : (
                            <span
                              key={`${g.row.graderId}:${g.row.metric}`}
                              className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-border/60 bg-muted/20 p-0.5"
                            >
                              <Badge title={g.row.metric} tone={scoreTone(g.row.pass)}>
                                {fmtMetricLabel(g.row.metric, caseMetrics)} {g.row.value}
                              </Badge>
                              {g.criteria.map((c) => (
                                <Badge
                                  key={c.row.metric}
                                  title={c.row.metric}
                                  tone={scoreTone(c.row.pass)}
                                >
                                  ›{' '}
                                  {c.parsed.kind === 'judge-criterion'
                                    ? c.parsed.criterionId
                                    : c.row.metric}{' '}
                                  {c.row.value}
                                </Badge>
                              ))}
                            </span>
                          )
                        )
                      )}
                    </div>
                  </div>
                  {/* os-use screenshot — base64 embedded (dev) or object storage URL (offload). The very image the VLM scored. */}
                  {osUseShotSrc(r.snapshot) && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={osUseShotSrc(r.snapshot)}
                      alt={`${r.caseId} screenshot`}
                      className="max-h-72 w-auto rounded-lg border"
                    />
                  )}
                  {/* browser (service-topology: browser-use etc.) — the final URL the agent reached (+ DOM excerpt). */}
                  {r.snapshot?.kind === 'browser' && r.snapshot.url && (
                    <p className="break-all font-mono text-[12px] text-muted-foreground">
                      <span className="font-[510] text-foreground">final url</span> ·{' '}
                      {r.snapshot.url}
                    </p>
                  )}
                  {/* judge/grader verdict reasoning (VLM rubric reasoning etc.) — shows "why pass/fail" for os-use and the like.
                    Grouped order (overall first, criteria indented beneath) so a multi-criteria judge's reasons read as one block. */}
                  {scoreGroups
                    .flatMap((g) => [{ row: g.row, parsed: g.parsed }, ...g.criteria])
                    .filter((e) => e.row.detail)
                    .map((e) => (
                      <p
                        key={`${e.row.graderId}:${e.row.metric}-detail`}
                        className={cn(
                          'rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground',
                          e.parsed.kind === 'judge-criterion' && 'ml-5'
                        )}
                      >
                        <MetricLabel
                          metric={e.row.metric}
                          siblings={caseMetrics}
                          className="mr-1 max-w-full align-middle font-[510] text-foreground"
                        />{' '}
                        · {e.row.detail}
                      </p>
                    ))}
                  {/* error events from the run trace — how the case failed (harness crash/dispatch error). */}
                  {(r.trace ?? [])
                    .filter((e) => e.kind === 'error' && typeof e.message === 'string')
                    .map((e, i) => (
                      <p
                        key={`trace-error-${i}`}
                        className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-[12px] leading-relaxed text-destructive"
                      >
                        <span className="font-[560]">error</span> · {e.message}
                      </p>
                    ))}
                  {/* Self-hosted runner failure (no_runner/capability) — show the runner's live health when we can resolve
                      it from the roster (online now / offline · last seen …), else a static hint, both pointing at the
                      "Retry failed cases" recovery above. failure.runnerId is set only for self-hosted ("*" = the pool). */}
                  {r.failure?.runnerId &&
                    (() => {
                      const rid = r.failure?.runnerId
                      const meta = rid && rid !== '*' ? runnerById.get(rid) : undefined
                      const text = !meta
                        ? t('failedOnRunnerHint')
                        : runnerOnline(meta.lastSeenAt)
                          ? t('failedOnRunnerOnline', { label: meta.label })
                          : t('failedOnRunnerOffline', {
                              label: meta.label,
                              ago: meta.lastSeenAt
                                ? fmtTimeAgo(meta.lastSeenAt, locale)
                                : t('runnerNeverSeen'),
                            })
                      return (
                        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-700 dark:text-amber-400">
                          {text}
                        </p>
                      )
                    })()}
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <CommentsSection
        workspace={workspace}
        resourceType="scorecard"
        resourceId={id}
        title={t('discussTitle')}
      />
    </div>
  )
}
