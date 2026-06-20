import Link from 'next/link'

import { TraceTimeline } from '@/widgets/trace-timeline'
import { runSchema, type Run } from '@/entities/run'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Card, CardContent } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'
import { StatusPill } from '@/shared/ui/status-pill'

export const dynamic = 'force-dynamic'

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm">{value}</dd>
    </div>
  )
}

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
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
      <div className="space-y-6">
        <PageHeader title="Run" />
        <Card className="border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          run 을 불러올 수 없습니다: {error}
        </Card>
        <Link href="/dashboard/runs" className="text-sm text-primary hover:opacity-80">
          ← Runs 로
        </Link>
      </div>
    )
  }

  const scores = run.result?.scores ?? []
  const trace = run.result?.trace ?? []
  const snapshot = run.result?.snapshot

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href="/dashboard/runs"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Runs
        </Link>
        <PageHeader
          title={`run ${run.id.slice(0, 8)}`}
          description={`${run.harness.id}@${run.harness.version} · case ${run.caseId}`}
          actions={<StatusPill status={run.status} />}
        />
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-5 sm:grid-cols-4">
          <Meta label="harness" value={`${run.harness.id}@${run.harness.version}`} />
          <Meta label="case" value={run.caseId} />
          <Meta label="created" value={new Date(run.createdAt).toLocaleString()} />
          <Meta label="updated" value={new Date(run.updatedAt).toLocaleString()} />
        </CardContent>
      </Card>

      {run.error && (
        <Card className="border-destructive/30 bg-destructive/5 p-5">
          <div className="text-sm font-semibold text-destructive">{run.error.code}</div>
          <div className="mt-1 text-sm text-muted-foreground">{run.error.message}</div>
        </Card>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">스코어</h2>
        {scores.length === 0 ? (
          <p className="text-sm text-muted-foreground">점수가 없습니다.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {scores.map((s) => (
              <Card key={s.graderId}>
                <CardContent className="pt-5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{s.graderId}</span>
                    {s.pass != null && (
                      <Badge tone={s.pass ? 'success' : 'danger'}>{s.pass ? 'pass' : 'fail'}</Badge>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">
                    {s.value}
                  </div>
                  <div className="text-xs text-muted-foreground">{s.metric}</div>
                  {/* 판정 사유(judge 루브릭 reasoning, command 출력 등) — os-use VLM 채점에서 "왜" 를 보여준다. */}
                  {s.detail && (
                    <p className="mt-2 border-t border-border/60 pt-2 text-xs leading-relaxed text-muted-foreground">
                      {s.detail}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">트레이스</h2>
        <Card className="p-5">
          <TraceTimeline trace={trace} />
        </Card>
      </section>

      {snapshot && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">스냅샷 ({String(snapshot.kind)})</h2>
          <Card className="space-y-3 p-5">
            {/* os-use 데스크탑 스크린샷(base64 PNG)을 인라인 표시 — 에이전트가 본 최종 화면. */}
            {typeof snapshot.screenshot === 'string' && snapshot.screenshot.length > 0 && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`data:image/png;base64,${snapshot.screenshot}`}
                alt="os-use screenshot"
                className="max-h-[480px] w-auto rounded-md border"
              />
            )}
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
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
