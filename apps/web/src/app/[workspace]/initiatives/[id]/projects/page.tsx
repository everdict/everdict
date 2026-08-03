import Link from 'next/link'
import { Target } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import type { InitiativeProjectSummary } from '@/entities/initiative'
import { memberDirectoryOf, memberNameOf } from '@/entities/member'
import { PROJECT_STATUSES, ProjectStatusBadge, type ProjectStatus } from '@/entities/project'
import { HealthBadge } from '@/entities/tracker-health'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'

import { loadInitiative } from '../load-initiative'

export const dynamic = 'force-dynamic'

// 프로젝트 탭 — 목표 아래의 일들이 **어느 단계에 있는지**. 리니어처럼 상태별로 묶고, 묶음의 순서는 상태
// 어휘의 순서(백로그 → 계획됨 → 진행 중 → 멈춤 → 완료 → 취소)를 그대로 따른다: 위에서 아래로 읽으면 그게
// 곧 일이 지나온 길이다. 상태별 개수는 각 묶음 머리에 붙어, 어디에 일이 몰려 있는지가 세지 않아도 보인다.
export default async function InitiativeProjectsPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('initiativesPage')
  const tracker = await getTranslations('tracker')
  const { initiative, initiatives, members } = await loadInitiative(id)
  if (!initiative) return null // 레이아웃이 이미 실패를 그렸다

  const { readiness } = initiative
  const actors = memberDirectoryOf(members)
  const initiativeName = new Map(initiatives.map((i) => [i.id, i.name]))

  const grouped: { status: ProjectStatus; items: InitiativeProjectSummary[] }[] =
    PROJECT_STATUSES.map((status) => ({
      status,
      items: readiness.projects.filter((project) => project.status === status),
    })).filter((group) => group.items.length > 0)

  if (grouped.length === 0) {
    return (
      <EmptyState
        icon={<Target strokeWidth={1.75} />}
        title={t('noProjectsTitle')}
        hint={t('noProjectsHint')}
      />
    )
  }

  return (
    <div className="space-y-6">
      {grouped.map((group) => (
        <section key={group.status} className="space-y-2">
          <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
            {tracker(`projectStatus.${group.status}`)} · {group.items.length}
          </p>
          <div className="space-y-2">
            {group.items.map((project) => (
              <Link
                key={project.id}
                href={`/${workspace}/projects/${encodeURIComponent(project.id)}`}
                className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-[510] text-foreground">
                  {project.name}
                  {/* 하위 목표를 거쳐 올라온 프로젝트는 어디에 걸려 있는지까지 말해야, 남은 일이 우산이
                      아니라 실제 지점을 가리킨다. */}
                  {project.viaInitiativeId !== undefined && (
                    <span className="ml-2 text-[11.5px] font-normal text-muted-foreground">
                      {initiativeName.get(project.viaInitiativeId) ?? project.viaInitiativeId}
                    </span>
                  )}
                </span>
                {project.lead !== undefined && (
                  <span className="hidden shrink-0 truncate text-[11.5px] text-muted-foreground @md:block">
                    {memberNameOf(actors, project.lead)}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {t('projectRollup', {
                    open: project.rollup.open,
                    done: project.rollup.done,
                    total: project.rollup.total,
                  })}
                </span>
                {project.rollup.open > 0 && <Badge tone="outline">{t('projectRemaining')}</Badge>}
                {project.targetDate && (
                  <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground @md:block">
                    {project.targetDate}
                  </span>
                )}
                {project.health !== undefined && <HealthBadge health={project.health} />}
                <ProjectStatusBadge status={project.status} />
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
