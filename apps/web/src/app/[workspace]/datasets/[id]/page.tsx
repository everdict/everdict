import Link from 'next/link'
import {
  BarChart3,
  Boxes,
  ChevronLeft,
  Clock,
  GitBranchPlus,
  GitCompare,
  History,
  ScrollText,
  Tags,
  Waypoints,
} from 'lucide-react'

import { VersionSwitcher } from '@/features/dataset-versions'
import {
  datasetSchema,
  datasetsSchema,
  type Dataset,
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
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

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
        <Callout tone="danger">데이터셋을 불러올 수 없습니다: {error}</Callout>
      </div>
    )
  }

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} />
        <PageHeader
          title={dataset.id}
          description={dataset.description ?? '하니스 무관 eval 케이스 묶음'}
          actions={
            <div className="flex items-end gap-2">
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
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border bg-secondary/40 px-3 text-[13px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
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
          {canPublish && (
            <span className="ml-auto text-[11.5px] text-faint">
              설명·태그·케이스 수정은 &lsquo;새 버전 만들기&rsquo;로 배포됩니다(버전 불변).
            </span>
          )}
        </div>
      </Card>

      {/* 출처(있으면) — 이 데이터셋이 어떤 레시피/카탈로그/spec 으로 만들어졌는지. 레시피면 상세로 역링크. */}
      {dataset.producedBy && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="text-faint">출처</span>
          {dataset.producedBy.via === 'recipe' ? (
            <span className="inline-flex items-center gap-1 font-mono text-muted-foreground">
              <ScrollText className="size-3.5" />
              {dataset.producedBy.id}
              {dataset.producedBy.version ? (
                <span className="text-faint">@{dataset.producedBy.version}</span>
              ) : null}
              <span className="text-faint">레시피</span>
            </span>
          ) : (
            <span className="font-mono">
              {dataset.producedBy.via === 'catalog' ? '카탈로그' : '인라인 정의'} ·{' '}
              {dataset.producedBy.id}
            </span>
          )}
        </div>
      )}

      {/* 관계된 하니스 — 이 데이터셋으로 평가된 하니스(스코어카드에서 도출). 데이터셋은 하니스 무관. */}
      {relation && relation.harnesses.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 text-faint">
            <Waypoints className="size-3.5" />이 데이터셋으로 평가된 하니스
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
          {relation.lastRunAt && (
            <span className="text-faint" title={fmtDateTimeFull(relation.lastRunAt)}>
              · 최근 실행 {fmtDateTime(relation.lastRunAt)}
            </span>
          )}
        </div>
      )}

      <section className="space-y-2.5">
        <SectionHeader title={`케이스 (${dataset.cases.length})`} />
        {dataset.cases.length === 0 ? (
          <EmptyState title="케이스가 없습니다." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH className="w-[180px]">case</TH>
                <TH>task</TH>
                <TH className="text-right">env · graders</TH>
              </tr>
            </THead>
            <TBody>
              {dataset.cases.map((c) => (
                <TR key={c.id}>
                  <TD className="font-mono text-[12px] text-foreground">{c.id}</TD>
                  <TD className="text-[13px] text-muted-foreground">{c.task}</TD>
                  <TD className="text-right">
                    <span className="inline-flex flex-wrap justify-end gap-1">
                      {c.env?.kind && (
                        <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                          {c.env.kind}
                        </code>
                      )}
                      {c.graders.map((g) => (
                        <code
                          key={g.id}
                          className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border"
                        >
                          {g.id}
                        </code>
                      ))}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  )
}
