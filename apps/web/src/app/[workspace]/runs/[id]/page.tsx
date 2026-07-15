import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { LiveLogs } from '@/widgets/live-logs'
import { LiveScreen, SandboxTerminal } from '@/widgets/sandbox-terminal'
import { TraceTimeline } from '@/widgets/trace-timeline'
import { CommentsSection } from '@/features/discuss'
import { runSchema, type Run } from '@/entities/run'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
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
          actions={<StatusPill status={run.status} />}
        />
      </div>

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Prop label="harness" value={`${run.harness.id}@${run.harness.version}`} />
        <Prop label="case" value={run.caseId} />
        <Prop label="created" value={new Date(run.createdAt).toLocaleString()} />
        <Prop label="updated" value={new Date(run.updatedAt).toLocaleString()} />
      </Card>

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
                className="font-mono underline underline-offset-2"
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

      <section className="space-y-2.5">
        <SectionHeader title={t('scores')} />
        {scores.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('noScores')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {/* key includes the metric — a multi-criteria judge emits several scores under one graderId. */}
            {scores.map((s) => (
              <Card key={`${s.graderId}:${s.metric}`} className="p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-[510]">{s.graderId}</span>
                  {s.pass != null && (
                    <Badge tone={s.pass ? 'success' : 'danger'}>{s.pass ? 'pass' : 'fail'}</Badge>
                  )}
                </div>
                <div className="mt-1.5 font-mono text-2xl font-[560] tabular-nums tracking-tight">
                  {s.value}
                </div>
                <div className="text-[12px] text-faint">
                  <MetricLabel metric={s.metric} siblings={scores.map((x) => x.metric)} />
                </div>
                {/* Verdict reasoning (judge rubric reasoning, command output, etc.) — shows the "why" in os-use VLM grading. */}
                {s.detail && (
                  <p className="mt-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-muted-foreground">
                    {s.detail}
                  </p>
                )}
              </Card>
            ))}
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
                className="max-h-[480px] w-auto rounded-lg border"
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
