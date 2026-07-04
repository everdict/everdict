import Link from 'next/link'
import {
  BarChart3,
  BookText,
  Boxes,
  ChevronLeft,
  Clock,
  Database,
  ExternalLink,
  FileText,
  GitBranchPlus,
  GitCompare,
  History,
  Scale,
  ScrollText,
  Tags,
  Trophy,
  Users,
  Waypoints,
} from 'lucide-react'

import { VersionSwitcher } from '@/features/dataset-versions'
import { ActivityTimeline, type ActivityItem, type Actor } from '@/features/discuss-dataset'
import { CaseList } from '@/features/inspect-dataset'
import { commentsResponseSchema } from '@/entities/comment'
import {
  datasetSchema,
  datasetsSchema,
  type Dataset,
  type DatasetProvenance,
  type DatasetSummary,
} from '@/entities/dataset'
import { membersSchema } from '@/entities/member'
import { scorecardsSchema } from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buildDatasetRelations } from '@/shared/lib/dataset-relations'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { sortSemverDesc } from '@/shared/lib/semver'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EnvBadge, GraderBadge } from '@/shared/ui/case-badges'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { InfoTip } from '@/shared/ui/tooltip'

export const dynamic = 'force-dynamic'

function BackLink({ workspace }: { workspace: string }) {
  return (
    <Link
      href={`/${workspace}/datasets`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      데이터셋
    </Link>
  )
}

export default async function DatasetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ version?: string }>
}) {
  const { workspace, id } = await params
  const { version } = await searchParams
  const { principal, ctx } = await currentPrincipal()

  // 이 데이터셋이 가진 모든 버전(최신순) + 목록 메타(만든이·생성/수정 시각) — 버전 선택기/diff/헤더에 사용.
  let versions: string[] = []
  let summary: DatasetSummary | undefined
  try {
    summary = datasetsSchema.parse(await controlPlane.listDatasets(ctx)).find((d) => d.id === id)
    if (summary) versions = sortSemverDesc(summary.versions)
  } catch {
    versions = []
  }

  // 관계 하니스(스코어카드 도출) + 만든이 이름(members 조인) — 부가 정보, 실패해도 상세는 보인다.
  const scorecards = await controlPlane
    .listScorecards(ctx)
    .then((r) => scorecardsSchema.parse(r))
    .catch(() => [])
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  // 댓글(활동 타임라인의 논의) — 실패해도 상세는 보인다.
  const comments = await controlPlane
    .listComments(ctx, 'dataset', id)
    .then((r) => commentsResponseSchema.parse(r).comments)
    .catch(() => [])
  const relation = buildDatasetRelations(scorecards)[id]
  const currentWorkspace = principal?.workspace ?? workspace
  // 만든이 — 프로필 이름+아바타(있으면). 시드/_shared 는 first-party 로 표기(아바타 없음).
  const author = (() => {
    if (!summary?.createdBy) {
      return {
        name: summary && summary.owner !== currentWorkspace ? 'first-party' : '—',
        known: false,
      }
    }
    const m = members.find((x) => x.subject === summary?.createdBy)
    return {
      name: m?.name ?? m?.email ?? fmtSubject(summary.createdBy),
      ...(m?.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
      known: true,
    }
  })()
  // 수정 = 새 버전 배포 — 이 워크스페이스 소유 데이터셋에서만(공유/first-party 는 제외).
  const canPublish = can(principal?.roles, 'datasets:write') && summary?.owner === currentWorkspace

  let dataset: Dataset | undefined
  let error: string | undefined
  try {
    dataset = datasetSchema.parse(await controlPlane.getDataset(ctx, id, version ?? 'latest'))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!dataset) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} />
        <PageHeader title="데이터셋" />
        <Callout tone="danger">데이터셋을 불러오지 못했어요: {error}</Callout>
      </div>
    )
  }

  // 케이스 구성 요약 — 환경(env.kind)·채점(grader.id) 분포(빈도순). 벤치마크 성격을 한눈에.
  const envSummary = [
    ...dataset.cases.reduce((m, c) => {
      const k = c.env?.kind
      if (k) m.set(k, (m.get(k) ?? 0) + 1)
      return m
    }, new Map<string, number>()),
  ].sort((a, b) => b[1] - a[1])
  const graderSummary = [
    ...dataset.cases.reduce((m, c) => {
      for (const g of c.graders) m.set(g.id, (m.get(g.id) ?? 0) + 1)
      return m
    }, new Map<string, number>()),
  ].sort((a, b) => b[1] - a[1])

  // 활동 타임라인 — "누가 언제 무엇을"(생성 · 스코어카드 실행 · 댓글)을 시간순으로. actor 는 여기서 표시-준비.
  const isAdmin = can(principal?.roles, 'settings:write') // settings:write = admin 전용 → admin 판정 프록시
  const resolveActor = (subject?: string): Actor => {
    if (!subject) return { name: '시스템', known: false }
    const m = members.find((x) => x.subject === subject)
    return {
      name: m?.name ?? m?.email ?? fmtSubject(subject),
      ...(m?.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
      known: Boolean(m),
    }
  }
  const activity: ActivityItem[] = []
  if (summary?.createdAt)
    activity.push({
      kind: 'created',
      at: summary.createdAt,
      actor: resolveActor(summary.createdBy),
    })
  for (const sc of scorecards.filter((s) => s.dataset.id === id)) {
    const m = sc.summary?.find((x) => x.passRate != null) ?? sc.summary?.[0]
    activity.push({
      kind: 'scorecard',
      at: sc.createdAt,
      actor: resolveActor(sc.createdBy),
      scorecardId: sc.id,
      harness: `${sc.harness.id}@${sc.harness.version}`,
      status: sc.status,
      passRate: m?.passRate ?? null,
    })
  }
  for (const c of comments)
    activity.push({
      kind: 'comment',
      at: c.createdAt,
      actor: resolveActor(c.author),
      id: c.id,
      body: c.body,
      canDelete: c.author === principal?.subject || isAdmin,
    })
  activity.sort((a, b) => a.at.localeCompare(b.at))
  const canComment = can(principal?.roles, 'comments:write')

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} />
        <PageHeader
          title={dataset.id}
          description={dataset.description ?? '어떤 하니스든 같은 문제로 평가해요.'}
          actions={
            <div className="flex items-center gap-2">
              {versions.length > 1 ? (
                <VersionSwitcher
                  id={dataset.id}
                  versions={versions}
                  current={dataset.version}
                  latest={versions[0]}
                />
              ) : (
                <Badge tone="neutral">v{dataset.version} (latest)</Badge>
              )}
              {versions.length > 1 && (
                <Link
                  href={`/${workspace}/datasets/${encodeURIComponent(dataset.id)}/diff`}
                  className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                >
                  <GitCompare className="size-3.5" />
                  버전 비교
                </Link>
              )}
              {canPublish && (
                <Link
                  href={`/${workspace}/datasets/${encodeURIComponent(dataset.id)}/new-version?v=${encodeURIComponent(dataset.version)}`}
                  className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                >
                  <GitBranchPlus className="size-3.5" />새 버전 만들기
                </Link>
              )}
            </div>
          }
        />
      </div>

      {/* 메타 패널 — 정의 그리드 대신 읽히는 메타 스트립 + 태그 칩. 버전 불변이라 수정은 '새 버전 만들기'로 배포. */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Boxes className="size-3.5 text-faint" />
            케이스{' '}
            <span className="font-[560] tabular-nums text-foreground">{dataset.cases.length}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <History className="size-3.5 text-faint" />
            버전{' '}
            <span className="font-[560] tabular-nums text-foreground">{versions.length || 1}</span>
            개
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground">
              v{dataset.version}
              {versions.length === 0 || dataset.version === versions[0] ? ' · latest' : ''}
            </code>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <BarChart3 className="size-3.5 text-faint" />
            스코어카드{' '}
            <span className="font-[560] tabular-nums text-foreground">
              {relation?.scorecards ?? 0}
            </span>
          </span>
          {summary?.createdAt && (
            <span
              className="inline-flex items-center gap-1.5"
              title={`생성 ${fmtDateTimeFull(summary.createdAt)}${summary.updatedAt ? ` · 수정 ${fmtDateTimeFull(summary.updatedAt)}` : ''}`}
            >
              <Clock className="size-3.5 text-faint" />
              생성 {fmtDateTime(summary.createdAt)}
              {summary.updatedAt && summary.updatedAt !== summary.createdAt
                ? ` · 수정 ${fmtDateTime(summary.updatedAt)}`
                : ''}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5" title={`만든이 ${author.name}`}>
            {author.known ? (
              <Avatar name={author.name} url={author.avatarUrl} size="sm" />
            ) : (
              <span className="text-faint">만든이</span>
            )}
            {author.name}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
          <Tags className="size-3.5 text-faint" />
          {dataset.tags.length > 0 ? (
            dataset.tags.map((t) => (
              <span
                key={t}
                className="rounded bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground ring-1 ring-inset ring-border"
              >
                {t}
              </span>
            ))
          ) : (
            <span className="text-[12px] text-faint">태그 없음</span>
          )}
          {/* 안내 문구는 인라인 노출 금지 — info 아이콘 호버 툴팁으로만. */}
          {canPublish && (
            <InfoTip
              className="ml-auto"
              align="end"
              content="버전은 바꿀 수 없어요. 수정하려면 새 버전을 만들어요."
            />
          )}
        </div>
      </Card>

      {/* 리니지(출처) — 이 데이터가 어디서 왔는지. 원본 소스(HF 링크) · 공식 provenance · 만든 경로. */}
      {dataset.producedBy && (
        <DatasetLineage workspace={workspace} provenance={dataset.producedBy} />
      )}

      {/* 관계된 하니스 — 이 데이터셋으로 평가된 하니스(스코어카드에서 도출). 아래 활동 타임라인의 요약. */}
      {relation && relation.harnesses.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 text-faint">
            <Waypoints className="size-3.5" />이 데이터셋으로 평가한 하니스
          </span>
          {relation.harnesses.map((h) => (
            <Link
              key={h}
              href={`/${workspace}/harnesses/${encodeURIComponent(h)}`}
              className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border transition-colors hover:text-foreground"
            >
              {h}
            </Link>
          ))}
        </div>
      )}

      {/* 활동 — 이 데이터셋에 일어난 일(생성 · 스코어카드 실행 · 댓글)을 시간순으로. 상세의 주(主) 내용. */}
      <section className="space-y-3">
        <SectionHeader title="활동" />
        <ActivityTimeline
          workspace={workspace}
          datasetId={dataset.id}
          items={activity}
          canComment={canComment}
        />
      </section>

      <section className="space-y-3">
        <SectionHeader title={`케이스 (${dataset.cases.length})`} />
        {dataset.cases.length === 0 ? (
          <EmptyState title="케이스가 없어요." />
        ) : (
          <>
            {/* 구성 요약 — 이 벤치마크가 어떤 환경에서 무엇으로 채점되는지 한눈에 */}
            <div className="space-y-2 rounded-lg border bg-card/60 p-3.5">
              <div className="flex gap-3">
                <span className="w-9 shrink-0 pt-1 text-[11px] font-[510] uppercase tracking-wide text-faint">
                  환경
                </span>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  {envSummary.length === 0 ? (
                    <span className="text-[12px] text-faint">—</span>
                  ) : (
                    envSummary.map(([kind, n]) => (
                      <span key={kind} className="inline-flex items-center gap-1">
                        <EnvBadge kind={kind} />
                        <span className="text-[12px] tabular-nums text-faint">{n}</span>
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="flex gap-3">
                <span className="w-9 shrink-0 pt-1 text-[11px] font-[510] uppercase tracking-wide text-faint">
                  채점
                </span>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  {graderSummary.length === 0 ? (
                    <span className="text-[12px] text-faint">—</span>
                  ) : (
                    graderSummary.map(([gid, n]) => (
                      <span key={gid} className="inline-flex items-center gap-1">
                        <GraderBadge id={gid} />
                        <span className="text-[12px] tabular-nums text-faint">{n}</span>
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* 케이스별 카드 — 기본 5개만, 확장 가능(상세의 주는 활동 히스토리라 케이스는 부차적). */}
            <CaseList cases={dataset.cases} />
          </>
        )}
      </section>
    </div>
  )
}

// 외부 링크 칩 — 리니지의 공식 provenance 링크(홈페이지/논문/코드/데이터/리더보드).
function LinkChip({
  href,
  icon: Icon,
  label,
}: {
  href: string
  icon: typeof BookText
  label: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[11px] font-[510] text-secondary-foreground ring-1 ring-inset ring-border transition-colors hover:text-foreground"
    >
      <Icon className="size-3" />
      {label}
      <ExternalLink className="size-2.5 text-faint" />
    </a>
  )
}

// 리니지(출처) 카드 — "이 데이터가 어디서 왔는지". 원본 소스(HF 링크) · 공식 provenance · 만든 경로.
// 데이터셋은 리니지가 핵심(오피셜 오픈 벤치마크의 출처 보존) — 정의그리드 대신 라벨-값 행으로 읽히게.
function DatasetLineage({
  workspace,
  provenance,
}: {
  workspace: string
  provenance: DatasetProvenance
}) {
  const { source, origin } = provenance
  const hfFileUrl =
    source?.kind === 'huggingface' && source.url && source.file
      ? `${source.url}/blob/main/${source.file}`
      : undefined

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
        <Waypoints className="size-3.5" /> 출처 · 리니지
      </div>

      {/* 원본 소스 — 데이터 행이 어디서 왔나(HF 데이터셋/파일 링크 or 붙여넣기). */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px]">
        <span className="w-14 shrink-0 text-[11px] font-[510] uppercase tracking-wide text-faint">
          소스
        </span>
        {source?.kind === 'huggingface' && source.dataset ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Database className="size-3.5 text-[#7cc0ff]" />
            <span className="text-muted-foreground">HuggingFace</span>
            {source.url ? (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono font-[510] text-foreground underline-offset-2 hover:text-primary hover:underline"
              >
                {source.dataset}
                <ExternalLink className="size-3 text-faint" />
              </a>
            ) : (
              <code className="font-mono text-foreground">{source.dataset}</code>
            )}
            {source.file ? (
              hfFileUrl ? (
                <a
                  href={hfFileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-inset ring-border transition-colors hover:text-foreground"
                >
                  <FileText className="size-3" />
                  {source.file}
                </a>
              ) : (
                <span className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-inset ring-border">
                  {source.file}
                </span>
              )
            ) : null}
            {source.config || source.split ? (
              <span className="font-mono text-[11px] text-faint">
                {[source.config, source.split].filter(Boolean).join(' / ')}
              </span>
            ) : null}
          </span>
        ) : source?.kind === 'jsonl' ? (
          <span className="text-muted-foreground">직접 붙여넣기 (JSONL)</span>
        ) : (
          <span className="text-faint">알 수 없음</span>
        )}
      </div>

      {/* 공식 provenance — 발표 벤치마크의 홈페이지/논문/코드/리더보드 + 라이선스/저자(있으면). */}
      {origin &&
        (origin.homepage ||
          origin.paper ||
          origin.code ||
          origin.data ||
          origin.leaderboard ||
          origin.license ||
          origin.authors) && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5 border-t pt-3 text-[12.5px]">
            <span className="w-14 shrink-0 text-[11px] font-[510] uppercase tracking-wide text-faint">
              공식
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              {origin.homepage && (
                <LinkChip href={origin.homepage} icon={ExternalLink} label="홈페이지" />
              )}
              {origin.paper && <LinkChip href={origin.paper} icon={BookText} label="논문" />}
              {origin.code && <LinkChip href={origin.code} icon={ScrollText} label="코드" />}
              {origin.data && <LinkChip href={origin.data} icon={Database} label="데이터" />}
              {origin.leaderboard && (
                <LinkChip href={origin.leaderboard} icon={Trophy} label="리더보드" />
              )}
              {origin.license && (
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Scale className="size-3 text-faint" />
                  {origin.license}
                </span>
              )}
              {origin.authors && (
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Users className="size-3 text-faint" />
                  {origin.authors}
                </span>
              )}
            </span>
          </div>
        )}

      {/* 만든 경로 — 레시피(역링크)/카탈로그/인라인 정의. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t pt-3 text-[12.5px]">
        <span className="w-14 shrink-0 text-[11px] font-[510] uppercase tracking-wide text-faint">
          경로
        </span>
        {provenance.via === 'recipe' ? (
          <Link
            href={`/${workspace}/recipes/${encodeURIComponent(provenance.id)}`}
            className="inline-flex items-center gap-1 font-mono text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <ScrollText className="size-3.5" />
            {provenance.id}
            {provenance.version ? <span className="text-faint">@{provenance.version}</span> : null}
            <span className="text-faint">레시피</span>
          </Link>
        ) : (
          <span className="font-mono text-muted-foreground">
            {provenance.via === 'catalog' ? '카탈로그' : '위저드 · 인라인 정의'}
            {provenance.id ? <span className="text-faint"> · {provenance.id}</span> : null}
          </span>
        )}
      </div>
    </Card>
  )
}
