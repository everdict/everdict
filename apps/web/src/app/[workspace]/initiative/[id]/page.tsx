import { ExternalLink } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import {
  initiativeHref,
  InitiativeStatusBadge,
  type InitiativeProjectSummary,
} from '@/entities/initiative'
import { ISSUE_STATUSES, issueHref, IssueStatusIcon } from '@/entities/issue'
import { memberDirectoryOf } from '@/entities/member'
import { PROJECT_STATUSES, type ProjectStatus } from '@/entities/project'
import { TrackerHistory } from '@/entities/tracker-history'
import { cn } from '@/shared/lib/utils'
import { Callout } from '@/shared/ui/callout'
import { DistributionBar } from '@/shared/ui/distribution-bar'
import { Link } from '@/shared/ui/link'
import { Markdown } from '@/shared/ui/markdown'
import { SectionHeader } from '@/shared/ui/section-header'

import { loadInitiative } from './load-initiative'

export const dynamic = 'force-dynamic'

// 개요 — 이 목표가 무엇이고, 지금 어디쯤인가. 리니어의 이니셔티브 개요와 같은 자리: 설명이 맨 위에 오고,
// 그 아래에서 **프로젝트들이 어느 단계에 있는지**(상태 사이클)와 이슈 단위 진척이 한 줄씩 답한다. 무엇이
// 남았는지는 그다음, 이력과 논의가 마지막이다.
export default async function InitiativeOverviewPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('initiativesPage')
  const tracker = await getTranslations('tracker')
  const { initiative, initiatives, members } = await loadInitiative(id)
  // 레이아웃이 이미 실패를 그렸다 — 여기서 두 번 말하지 않는다.
  if (!initiative) return null

  const current = initiative
  const { readiness } = current
  const children = initiatives.filter((i) => i.parentId === current.id)
  const actors = memberDirectoryOf(members)

  // 프로젝트들이 어느 단계에 있는가 — 목표 아래 일의 "지금". 상태 순서는 어휘의 순서(백로그 → 취소)대로
  // 두어, 막대를 왼쪽에서 오른쪽으로 읽으면 그대로 진행 순서가 된다.
  const projectsByStatus = new Map<ProjectStatus, InitiativeProjectSummary[]>()
  for (const project of readiness.projects) {
    projectsByStatus.set(project.status, [...(projectsByStatus.get(project.status) ?? []), project])
  }
  const projectSegments = PROJECT_STATUSES.map((status) => ({
    label: tracker(`projectStatus.${status}`),
    count: projectsByStatus.get(status)?.length ?? 0,
  })).filter((segment) => segment.count > 0)

  // 이슈 단위 진척 — 각 프로젝트의 롤업을 합친 것. 서버가 모든 상태 키를 채워 보내므로 빈 값 분기가 없다.
  const issueSegments = ISSUE_STATUSES.map((status) => ({
    label: tracker(`issueStatus.${status}`),
    count: readiness.projects.reduce((sum, p) => sum + (p.rollup.byStatus[status] ?? 0), 0),
  })).filter((segment) => segment.count > 0)

  return (
    <div className="space-y-7">
      {/* 설명은 이름 바로 아래에서 시작한다(섹션 제목 없이) — 이 화면의 본문은 목표 그 자체다. 이슈 본문과
          같은 마크다운 표면을 쓴다: 목표를 정의하는 글에는 링크와 목록이 들어가고, 그걸 평문으로 두면
          "무엇이 참이면 이룬 것인가"가 한 덩어리 문단이 된다. */}
      {current.description && <Markdown content={current.description} />}

      {(projectSegments.length > 0 || issueSegments.length > 0) && (
        <section className="space-y-4">
          <SectionHeader
            title={t('progressTitle')}
            action={
              readiness.projects.length > 0 ? (
                <Link
                  href={initiativeHref(workspace, current.id, 'projects')}
                  className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t('seeProjects')}
                </Link>
              ) : null
            }
          />
          {projectSegments.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                {t('projectPhaseTitle')}
              </p>
              <DistributionBar segments={projectSegments} />
            </div>
          )}
          {issueSegments.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                {t('issuePhaseTitle')}
              </p>
              <DistributionBar segments={issueSegments} />
            </div>
          )}
        </section>
      )}

      {/* 목표 아래 프로젝트가 하나도 없으면 진척은 셀 것이 없다 — 왜 비어 있는지는 여기서 말한다. */}
      {readiness.projects.length === 0 && <Callout tone="info">{t('noProjectsHint')}</Callout>}

      {/* 남은 일 — 회귀가 먼저다(서버가 그렇게 정렬해 보낸다). 무너진 해결은 새 일보다 먼저 봐야 한다. */}
      {readiness.blockers.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title={t('remainingTitle')}
            action={
              <span className="text-[12px] tabular-nums text-faint">
                {t('remainingCount', { count: readiness.openIssues })}
              </span>
            }
          />
          <div className="space-y-2">
            {readiness.blockers.map((blocker) => (
              <Link
                key={blocker.issueId}
                href={issueHref(workspace, blocker.identifier, blocker.title)}
                className={cn(
                  'flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated',
                  blocker.status === 'regressed' && 'border-destructive/40 bg-destructive/5'
                )}
              >
                <IssueStatusIcon status={blocker.status} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {blocker.title}
                </span>
                <span className="hidden shrink-0 text-[11px] text-muted-foreground @md:block">
                  {tracker(`issueStatus.${blocker.status}`)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 리소스 — 목표가 적히고, 측정되고, 논쟁된 곳. 빈 섹션은 내지 않는다(하우스 규칙). */}
      {current.resources.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title={t('resourcesTitle')} />
          <div className="space-y-2">
            {current.resources.map((resource) => (
              <a
                key={resource.url}
                href={resource.url}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <ExternalLink className="size-3.5 shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {resource.label}
                </span>
                <span className="hidden shrink-0 truncate text-[11.5px] text-muted-foreground @md:block">
                  {new URL(resource.url).hostname}
                </span>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* 하위 목표 — 큰 목표는 쪼개진다. 상위는 속성 열이 이고 있으므로 여기서는 아래만 센다. */}
      {children.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title={t('subInitiativesTitle', { count: children.length })} />
          <div className="space-y-2">
            {children.map((child) => (
              <Link
                key={child.id}
                href={initiativeHref(workspace, child.id)}
                className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {child.name}
                </span>
                <InitiativeStatusBadge status={child.status} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {current.history.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title={t('historyTitle')} />
          <TrackerHistory
            kind="initiative"
            subject={tracker('subject.initiative')}
            entries={current.history}
            actors={actors}
            workspace={workspace}
          />
        </section>
      )}

      <CommentsSection
        workspace={workspace}
        resourceType="initiative"
        resourceId={current.id}
        title={t('discussTitle')}
      />
    </div>
  )
}
