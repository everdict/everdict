import Link from 'next/link'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { TeamScopeBar } from '@/widgets/team-scope-bar'
import { issueHref, issuePageSchema, IssueStatusIcon, type IssueSummary } from '@/entities/issue'
import { projectsSchema, type Project } from '@/entities/project'
import { teamSectionHref } from '@/entities/team'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime } from '@/shared/lib/format'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { loadTeamScope } from '../../team-scope'

export const dynamic = 'force-dynamic'

const RECENT = 8

// 팀 Home — 사이드바에서 팀을 폈을 때 첫 목적지. "이 팀이 지금 무엇을 하고 있나"에 답하는 요약이고,
// 목록 자체는 팀 아래의 자원들(`…/issues`, `…/projects`)이 소유한다. 팀 *설정*(이름·키·로스터)은
// Settings › Teams 가 계속 소유한다 — 여기는 일하는 화면이다.
export default async function TeamHomePage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { workspace, key } = await params
  const t = await getTranslations('teamHome')
  const tracker = await getTranslations('tracker')
  const timeZone = await getTimeZone()
  // 슬러그 해석 + 정규화 + 접근 판정. 없는 팀도 볼 수 없는 팀도 404 다.
  const team = await loadTeamScope({ workspace, slug: key })
  const ctx = await authContext()

  const [issues, projects] = await Promise.all([
    controlPlane
      .listIssues(ctx, { team: team.id, limit: RECENT })
      .then((r) => issuePageSchema.parse(r).items)
      .catch((): IssueSummary[] => []),
    controlPlane
      .listProjects(ctx, { team: team.id })
      .then((r) => projectsSchema.parse(r))
      .catch((): Project[] => []),
  ])

  return (
    <div className="space-y-6">
      <TeamScopeBar scope={{ workspace, team, section: 'home' }} />
      <PageHeader title={team.name} description={team.description ?? undefined} />

      {/* 메타 스트립 — 상세 뷰 관습(빈 dl 격자 대신 한 줄). 숫자는 서버가 read 마다 파생한다. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        <span>{t('openIssues', { count: team.summary.openIssues })}</span>
        <span>{t('totalIssues', { count: team.summary.totalIssues })}</span>
        <span>{t('members', { count: team.summary.memberCount })}</span>
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-[510] text-foreground">{t('recentIssues')}</h2>
          <Link
            href={teamSectionHref(workspace, team.key, 'issues')}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
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

      {/* 이 팀이 하고 있는 프로젝트 — 프로젝트는 자기 팀들을 이름으로 들고 있다. */}
      {projects.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-[510] text-foreground">{t('projects')}</h2>
            <Link
              href={teamSectionHref(workspace, team.key, 'projects')}
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
