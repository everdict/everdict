import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import { membersSchema } from '@/entities/member'
import { runsSchema } from '@/entities/run'
import { caseVerdict, scorecardRecordSchema, type ScorecardRecord } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { env } from '@/shared/config/env'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtPct, fmtSubject, HEALTH_TEXT, rateHealth } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { AutoRefresh } from '@/shared/ui/auto-refresh'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { ModelChip, RuntimeChip } from '@/shared/ui/chip'
import { OriginBlock } from '@/shared/ui/origin'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatCard } from '@/shared/ui/stat-card'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

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

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">{label}</dt>
      <dd className="mt-1 truncate font-mono text-[13px] text-foreground">{value}</dd>
    </div>
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
  searchParams: Promise<{ cases?: string }>
}) {
  const { workspace, id } = await params
  const { cases } = await searchParams
  const ctx = await authContext()
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
  const results = record.scorecard?.results ?? []
  const steps = record.steps ?? []
  const live = record.status === 'queued' || record.status === 'running'

  // Compute the per-case verdict once and share it across rollup · sort · filter.
  const cased = results.map((r) => ({ r, verdict: caseVerdict(r.scores) }))
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
  const childRunByCase = new Map<string, string>()
  if (results.length > 0) {
    try {
      const children = runsSchema.parse(await controlPlane.listRuns(ctx, { scorecardId: id }))
      for (const c of children) childRunByCase.set(c.caseId, c.id)
    } catch {
      // Child run lookup fails/missing → render without drilldown links (keep current behavior)
    }
  }

  return (
    <div className="space-y-7">
      {/* In progress: periodically re-run the server component to live-update steps (stops once terminal). */}
      <AutoRefresh enabled={live} />
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader
          title={<span className="font-mono">scorecard {record.id.slice(0, 8)}</span>}
          description={`${record.dataset.id}@${record.dataset.version} → ${record.harness.id}@${record.harness.version}`}
          actions={<StatusPill status={record.status} />}
        />
      </div>

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

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Prop label="dataset" value={`${record.dataset.id}@${record.dataset.version}`} />
        <Prop label="harness" value={`${record.harness.id}@${record.harness.version}`} />
        <Prop label="created" value={new Date(record.createdAt).toLocaleString()} />
        <Prop label="updated" value={new Date(record.updatedAt).toLocaleString()} />
        {authorName && <Prop label={t('metaRunBy')} value={authorName} />}
        {/* The runtime this batch ran on — a registered runtime links to its detail, self:* runners get only a chip (runners have no runtime detail page). Hidden if unset (legacy · ingest). */}
        {record.runtime && (
          <div className="min-w-0">
            <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
              {t('metaRuntime')}
            </dt>
            <dd className="mt-1">
              {record.runtime.startsWith('self:') ? (
                <RuntimeChip label={record.runtime} />
              ) : (
                <Link
                  href={`/${workspace}/runtimes/${encodeURIComponent(record.runtime)}`}
                  className="rounded-sm hover:underline"
                  title={t('runtimeDetailTitle')}
                >
                  <RuntimeChip label={record.runtime} />
                </Link>
              )}
            </dd>
          </div>
        )}
        {/* Temporal-owned batch — the durable workflow's id; deep-links to the Temporal UI when TEMPORAL_UI_URL is set. */}
        {record.orchestration?.workflowId && (
          <div className="min-w-0">
            <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">
              {t('metaWorkflow')}
            </dt>
            <dd className="mt-1 truncate font-mono text-[13px] text-foreground">
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
            </dd>
          </div>
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
      </Card>

      {/* Trigger provenance — CI/schedule/API/web + commit · PR · CI run links + PR ephemeral pins (pinOverrides). */}
      {record.origin && <OriginBlock origin={record.origin} />}

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
              {summary.map((m) => (
                <TR key={m.metric}>
                  <TD className="font-mono text-[12px] font-[510]">{m.metric}</TD>
                  <TD className="text-right font-mono text-[12px] tabular-nums">
                    {m.mean.toFixed(2)}
                  </TD>
                  <TD className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                    {m.count}
                  </TD>
                  <TD className="text-right font-mono text-[12px] tabular-nums">
                    {m.passRate == null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <span className={HEALTH_TEXT[rateHealth(m.passRate)]}>
                        {fmtPct(m.passRate)}
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
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
            {shown.map(({ r, verdict }) => (
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
                      r.scores.map((s) => (
                        <Badge
                          key={s.graderId}
                          tone={s.pass == null ? 'neutral' : s.pass ? 'success' : 'danger'}
                        >
                          {s.metric} {s.value}
                        </Badge>
                      ))
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
                    <span className="font-[510] text-foreground">final url</span> · {r.snapshot.url}
                  </p>
                )}
                {/* judge/grader verdict reasoning (VLM rubric reasoning etc.) — shows "why pass/fail" for os-use and the like. */}
                {r.scores
                  .filter((s) => s.detail)
                  .map((s) => (
                    <p
                      key={`${s.graderId}-detail`}
                      className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground"
                    >
                      <span className="font-[510] text-foreground">{s.metric}</span> · {s.detail}
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
              </Card>
            ))}
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
