import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { caseVerdict, scorecardRecordSchema, type ScorecardRecord } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { cn } from '@/shared/lib/utils'
import { AutoRefresh } from '@/shared/ui/auto-refresh'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatusPill } from '@/shared/ui/status-pill'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

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
      href={`/${workspace}/scorecards`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      스코어카드
    </Link>
  )
}

export default async function ScorecardDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const ctx = await authContext()

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
        <BackLink workspace={workspace} />
        <PageHeader title="스코어카드" />
        <Callout tone="danger">스코어카드를 불러올 수 없습니다: {error}</Callout>
      </div>
    )
  }

  const summary = record.summary ?? []
  const results = record.scorecard?.results ?? []
  const failedCount = results.filter((r) => caseVerdict(r.scores) === false).length
  const steps = record.steps ?? []
  const live = record.status === 'queued' || record.status === 'running'

  return (
    <div className="space-y-7">
      {/* 진행 중이면 서버 컴포넌트를 주기 재실행해 스텝을 라이브 갱신(종단되면 멈춤). */}
      <AutoRefresh enabled={live} />
      <div className="space-y-3">
        <BackLink workspace={workspace} />
        <PageHeader
          title={<span className="font-mono">scorecard {record.id.slice(0, 8)}</span>}
          description={`${record.dataset.id}@${record.dataset.version} → ${record.harness.id}@${record.harness.version}`}
          actions={<StatusPill status={record.status} />}
        />
      </div>

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Prop label="dataset" value={`${record.dataset.id}@${record.dataset.version}`} />
        <Prop label="harness" value={`${record.harness.id}@${record.harness.version}`} />
        <Prop label="created" value={new Date(record.createdAt).toLocaleString()} />
        <Prop label="updated" value={new Date(record.updatedAt).toLocaleString()} />
      </Card>

      {record.error && (
        <Callout tone="danger" hint={record.error.message}>
          {record.error.phase
            ? `${record.error.code} · ${record.error.phase} 구간에서 실패`
            : record.error.code}
        </Callout>
      )}

      {(steps.length > 0 || live) && (
        <section className="space-y-2.5">
          <SectionHeader
            title="진행 과정"
            action={live ? <Badge tone="neutral">진행 중 · 자동 갱신</Badge> : undefined}
          />
          {steps.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">실행을 시작하는 중입니다…</p>
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
        <SectionHeader title="집계 (메트릭별)" />
        {summary.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">집계가 없습니다.</p>
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
                      <span
                        className={
                          m.passRate >= 1
                            ? 'text-[var(--color-success)]'
                            : m.passRate > 0
                              ? 'text-foreground'
                              : 'text-destructive'
                        }
                      >
                        {Math.round(m.passRate * 100)}%
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="space-y-2.5">
        <SectionHeader
          title={`케이스별 (${results.length})`}
          action={
            failedCount > 0 ? (
              <Badge tone="danger">실패 {failedCount}</Badge>
            ) : results.length > 0 ? (
              <Badge tone="success">전부 통과</Badge>
            ) : undefined
          }
        />
        {results.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {record.status === 'failed'
              ? '케이스 결과가 없습니다 — 위 오류 구간을 확인하세요(디스패치 이전 단계 실패).'
              : record.status === 'running' || record.status === 'queued'
                ? '아직 실행 중입니다 — 완료되면 케이스별 결과가 표시됩니다.'
                : '케이스 결과가 없습니다.'}
          </p>
        ) : (
          <div className="space-y-2">
            {results.map((r) => {
              const verdict = caseVerdict(r.scores)
              return (
                <Card key={r.caseId} className="space-y-2 p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="flex items-center gap-2">
                      <Badge tone={verdict == null ? 'neutral' : verdict ? 'success' : 'danger'}>
                        {verdict == null ? 'SKIP' : verdict ? 'PASS' : 'FAIL'}
                      </Badge>
                      <span className="font-mono text-[13px] font-[510]">{r.caseId}</span>
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {r.snapshot?.kind && <Badge tone="neutral">{String(r.snapshot.kind)}</Badge>}
                      {r.scores.length === 0 ? (
                        <span className="text-[12px] text-muted-foreground">점수 없음</span>
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
                  {/* os-use 스크린샷 — base64 동봉(dev) 또는 object storage URL(오프로드). VLM 이 채점한 그 이미지. */}
                  {osUseShotSrc(r.snapshot) && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={osUseShotSrc(r.snapshot)}
                      alt={`${r.caseId} screenshot`}
                      className="max-h-72 w-auto rounded-lg border"
                    />
                  )}
                  {/* browser(서비스-토폴로지: browser-use 등) — 에이전트가 도달한 최종 URL(+ DOM 발췌). */}
                  {r.snapshot?.kind === 'browser' && r.snapshot.url && (
                    <p className="break-all font-mono text-[12px] text-muted-foreground">
                      <span className="font-[510] text-foreground">final url</span> ·{' '}
                      {r.snapshot.url}
                    </p>
                  )}
                  {/* judge/grader 판정 사유(VLM 루브릭 reasoning 등) — os-use 등에서 "왜 pass/fail" 을 보여준다. */}
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
                  {/* 실행 트레이스의 error 이벤트 — 케이스가 어떻게 실패했는지(하니스 크래시/디스패치 오류). */}
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
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
