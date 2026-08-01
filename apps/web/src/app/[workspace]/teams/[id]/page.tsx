import Link from 'next/link'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { issueHref, issuesSchema, IssueStatusIcon, type Issue } from '@/entities/issue'
import { projectsSchema, type Project } from '@/entities/project'
import { TeamKeyBadge, teamWithSummarySchema, type TeamWithSummary } from '@/entities/team'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime } from '@/shared/lib/format'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

const RECENT = 8

// 팀 Home — 사이드바에서 팀을 폈을 때 첫 목적지. "이 팀이 지금 무엇을 하고 있나"에 답하는 요약이고,
// 목록 자체는 Issues/Projects 가 소유한다(여기서 필터를 또 제공하면 두 개의 목록 화면이 생긴다).
// 팀 *설정*(이름·키·로스터)은 Settings › Teams 가 계속 소유한다 — 여기는 일하는 화면이다.
export default async function TeamHomePage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('teamHome')
  const tracker = await getTranslations('tracker')
  const timeZone = await getTimeZone()
  const ctx = await authContext()

  let team: TeamWithSummary | undefined
  let error: string | undefined
  try {
    team = teamWithSummarySchema.parse(await controlPlane.getTeam(ctx, id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!team) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('title')} />
        <Callout tone="danger">{error ?? t('notFound')}</Callout>
      </div>
    )
  }

  const [issues, projects] = await Promise.all([
    controlPlane
      .listIssues(ctx, { team: id, limit: RECENT })
      .then((r) => issuesSchema.parse(r))
      .catch((): Issue[] => []),
    controlPlane
      .listProjects(ctx, { team: id })
      .then((r) => projectsSchema.parse(r))
      .catch((): Project[] => []),
  ])

  const issuesHref = `/${workspace}/issues?team=${encodeURIComponent(id)}`
  const projectsHref = `/${workspace}/projects?team=${encodeURIComponent(id)}`

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <TeamKeyBadge teamKey={team.key} />
            {team.name}
          </span>
        }
        description={team.description ?? undefined}
      />

      {/* 메타 스트립 — 상세 뷰 관습(빈 dl 격자 대신 한 줄). 숫자는 서버가 read 마다 파생한다. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        <span>{t('openIssues', { count: team.summary.openIssues })}</span>
        <span>{t('totalIssues', { count: team.summary.totalIssues })}</span>
        <span>{t('members', { count: team.summary.memberCount })}</span>
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-[510] text-foreground">{t('recentIssues')}</h2>
          <Link href={issuesHref} className="text-xs text-muted-foreground hover:text-foreground">
            {t('viewAll')}
          </Link>
        </div>
        {issues.length === 0 ? (
          <EmptyState title={t('noIssues')} />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {issues.map((issue) => (
              <li key={issue.id}>
                <Link
                  href={issueHref(workspace, issue.identifier)}
                  className="flex items-center gap-2.5 px-3 py-2 text-[13px] hover:bg-accent/40"
                >
                  <IssueStatusIcon status={issue.status} />
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {issue.identifier}
                  </span>
                  <span className="truncate">{issue.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {tracker(`status_${issue.status}`)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 이 팀이 이슈를 갖고 있는 프로젝트 — 프로젝트에는 팀이 없으므로 서버가 이슈에서 파생한다. */}
      {projects.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-[510] text-foreground">{t('projects')}</h2>
            <Link
              href={projectsHref}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {t('viewAll')}
            </Link>
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/${workspace}/projects/${encodeURIComponent(project.id)}`}
                  className="flex items-center gap-2.5 px-3 py-2 text-[13px] hover:bg-accent/40"
                >
                  <span className="truncate">{project.name}</span>
                  {project.targetDate && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {fmtDateTime(project.targetDate, timeZone)}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
