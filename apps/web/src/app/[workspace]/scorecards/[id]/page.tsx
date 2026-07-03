import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { membersSchema } from '@/entities/member'
import { runsSchema } from '@/entities/run'
import { caseVerdict, scorecardRecordSchema, type ScorecardRecord } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtPct, fmtSubject, HEALTH_TEXT, rateHealth } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { AutoRefresh } from '@/shared/ui/auto-refresh'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { ModelChip } from '@/shared/ui/chip'
import { OriginBlock } from '@/shared/ui/origin'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatCard } from '@/shared/ui/stat-card'
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

// 케이스 필터 세그먼트 — 전체 ↔ 실패만(#cases 앵커로 스크롤 유지). 서버 컴포넌트라 URL 파라미터로 토글.
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
        <Callout tone="danger">스코어카드를 불러오지 못했어요: {error}</Callout>
      </div>
    )
  }

  // 실행자 이름(members 조인) — 부가 정보라 실패해도 상세는 보인다. 이름은 프로필 name > email 로컬파트 > subject 축약.
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

  // 케이스별 판정을 한 번만 계산해 롤업·정렬·필터에 공유.
  const cased = results.map((r) => ({ r, verdict: caseVerdict(r.scores) }))
  const passed = cased.filter((c) => c.verdict === true).length
  const failedCount = cased.filter((c) => c.verdict === false).length
  const skipped = cased.filter((c) => c.verdict == null).length
  const passRate = results.length > 0 ? passed / results.length : null

  // 실패 우선 정렬(fail → skip → pass), 그다음 실패만/전체 필터.
  const filter = cases === 'failed' ? 'failed' : 'all'
  const weight = (v: boolean | undefined) => (v === false ? 0 : v == null ? 1 : 2)
  const ordered = [...cased].sort((a, b) => weight(a.verdict) - weight(b.verdict))
  const shown = filter === 'failed' ? ordered.filter((c) => c.verdict === false) : ordered
  const base = `/${workspace}/scorecards/${encodeURIComponent(id)}`

  // 케이스 드릴다운: 이 스코어카드가 팬아웃한 자식 run(있으면) → caseId→runId. 구(舊)/ingest 스코어카드는 자식이 없어 빈 맵.
  const childRunByCase = new Map<string, string>()
  if (results.length > 0) {
    try {
      const children = runsSchema.parse(await controlPlane.listRuns(ctx, { scorecardId: id }))
      for (const c of children) childRunByCase.set(c.caseId, c.id)
    } catch {
      // 자식 run 조회 실패/없음 → 드릴다운 링크 없이 렌더(현행 유지)
    }
  }

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

      {/* 케이스 롤업 — 이 실행의 헤드라인 결과(통과/실패 한눈에). 결과가 있을 때만. */}
      {results.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="케이스"
            value={results.length}
            hint={skipped > 0 ? `스킵 ${skipped}` : undefined}
          />
          <StatCard label="통과" value={passed} tone={passed > 0 ? 'success' : 'default'} />
          <StatCard
            label="실패"
            value={failedCount}
            tone={failedCount > 0 ? 'danger' : 'default'}
          />
          <StatCard
            label="통과율"
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
        {authorName && <Prop label="실행자" value={authorName} />}
      </Card>

      {/* 트리거 출처(provenance) — CI/예약/API/웹 + 커밋·PR·CI run 링크 + PR 임시 핀(pinOverrides). */}
      {record.origin && <OriginBlock origin={record.origin} />}

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
              <span className="text-[11px] text-muted-foreground">관측</span>
              {record.models.observed.map((m) => (
                <ModelChip key={m} muted>
                  {m}
                </ModelChip>
              ))}
            </div>
          )}
          {record.models?.declared && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">선언</span>
              <ModelChip muted>{record.models.declared}</ModelChip>
              {record.models.primary && record.models.declared !== record.models.primary && (
                <Badge tone="danger">선언≠실제</Badge>
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
            <p className="text-[13px] text-muted-foreground">실행을 준비하고 있어요…</p>
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
        <SectionHeader title="메트릭별 집계" />
        {summary.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">집계가 없어요.</p>
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
          title={`케이스별 (${results.length})`}
          action={
            failedCount > 0 ? (
              <div className="inline-flex overflow-hidden rounded-md border">
                <CaseFilterTab href={`${base}#cases`} active={filter === 'all'}>
                  전체 {results.length}
                </CaseFilterTab>
                <CaseFilterTab
                  href={`${base}?cases=failed#cases`}
                  active={filter === 'failed'}
                  danger
                >
                  실패 {failedCount}
                </CaseFilterTab>
              </div>
            ) : results.length > 0 ? (
              <Badge tone="success">전부 통과</Badge>
            ) : undefined
          }
        />
        {results.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {record.status === 'failed'
              ? '케이스 결과가 없어요. 위 오류를 확인해보세요.'
              : record.status === 'running' || record.status === 'queued'
                ? '아직 실행 중이에요. 끝나면 케이스별 결과가 보여요.'
                : '케이스 결과가 없어요.'}
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
                    {/* 이 케이스의 자식 run(있으면) — 전체 트레이스/usage/provenance 드릴다운. */}
                    {childRunByCase.get(r.caseId) && (
                      <Link
                        href={`/${workspace}/runs/${childRunByCase.get(r.caseId)}`}
                        className="font-mono text-[11px] text-link transition-colors hover:text-foreground"
                      >
                        → run
                      </Link>
                    )}
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
                    <span className="font-[510] text-foreground">final url</span> · {r.snapshot.url}
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
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
