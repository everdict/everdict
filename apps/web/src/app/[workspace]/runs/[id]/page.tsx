import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { TraceTimeline } from '@/widgets/trace-timeline'
import { runSchema, type Run } from '@/entities/run'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatusPill } from '@/shared/ui/status-pill'

export const dynamic = 'force-dynamic'

// os-use 스크린샷 src: base64 동봉(dev) → data URL, 아니면 object storage URL(오프로드). 둘 다 없으면 undefined.
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

function BackLink({ workspace }: { workspace: string }) {
  return (
    <Link
      href={`/${workspace}/runs`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      Runs
    </Link>
  )
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
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
        <BackLink workspace={workspace} />
        <PageHeader title="Run" />
        <Callout tone="danger">run 을 불러올 수 없습니다: {error}</Callout>
      </div>
    )
  }

  const scores = run.result?.scores ?? []
  const trace = run.result?.trace ?? []
  const snapshot = run.result?.snapshot

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} />
        <PageHeader
          title={<span className="font-mono">run {run.id.slice(0, 8)}</span>}
          description={`${run.harness.id}@${run.harness.version} · case ${run.caseId}`}
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

      <section className="space-y-2.5">
        <SectionHeader title="스코어" />
        {scores.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">점수가 없습니다.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {scores.map((s) => (
              <Card key={s.graderId} className="p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-[510]">{s.graderId}</span>
                  {s.pass != null && (
                    <Badge tone={s.pass ? 'success' : 'danger'}>{s.pass ? 'pass' : 'fail'}</Badge>
                  )}
                </div>
                <div className="mt-1.5 font-mono text-2xl font-[560] tabular-nums tracking-tight">
                  {s.value}
                </div>
                <div className="text-[12px] text-faint">{s.metric}</div>
                {/* 판정 사유(judge 루브릭 reasoning, command 출력 등) — os-use VLM 채점에서 "왜" 를 보여준다. */}
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
        <SectionHeader title="트레이스" />
        <Card className="p-4">
          <TraceTimeline trace={trace} />
        </Card>
      </section>

      {snapshot && (
        <section className="space-y-2.5">
          <SectionHeader title={`스냅샷 (${String(snapshot.kind)})`} />
          <Card className="space-y-3 p-4">
            {/* os-use 스크린샷 — base64 동봉(dev) 또는 object storage URL(오프로드). 에이전트가 본 최종 화면. */}
            {osUseShotSrc(snapshot) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={osUseShotSrc(snapshot)}
                alt="os-use screenshot"
                className="max-h-[480px] w-auto rounded-lg border"
              />
            )}
            {/* browser(서비스-토폴로지: browser-use 등) — 에이전트가 도달한 최종 URL + 추출 DOM 발췌. */}
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
    </div>
  )
}
