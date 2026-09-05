import { Target } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import {
  AddInitiativeProjectsButton,
  RemoveInitiativeProjectButton,
} from '@/features/manage-initiative'
import { projectCandidatesFor, type InitiativeProjectSummary } from '@/entities/initiative'
import { memberDirectoryOf, memberNameOf } from '@/entities/member'
import {
  PROJECT_STATUSES,
  projectsSchema,
  ProjectStatusBadge,
  type Project,
  type ProjectStatus,
} from '@/entities/project'
import { HealthBadge } from '@/entities/tracker-health'
import { can } from '@/shared/auth/can'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'

import { loadInitiative } from '../load-initiative'

export const dynamic = 'force-dynamic'

// The projects tab — **what stage** the work under this goal is at. Grouped by status as Linear does, with the group order following the
// status vocabulary (backlog → planned → in progress → paused → done → cancelled): read top to bottom, that IS the path work travels.
// The per-status counts sit on each group header, so where work has piled up is visible without counting.
export default async function InitiativeProjectsPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('initiativesPage')
  const tracker = await getTranslations('tracker')
  const { initiative, initiatives, members, roles } = await loadInitiative(id)
  if (!initiative) return null // the layout already drew the failure

  // The candidates that can be added to the goal — the workspace projects that do not already name it. The link is a field on the PROJECT side,
  // so the list still renders on failure (only the add button stands disabled).
  const ctx = await authContext()
  const allProjects: Project[] = await controlPlane
    .listProjects(ctx)
    .then((r) => projectsSchema.parse(r))
    .catch((): Project[] => [])
  const candidates = projectCandidatesFor(id, allProjects)
  // Adding a project to and removing it from a goal is EDITING THE PROJECT — the same judgement as tracker write permission.
  const canEdit = can(roles, 'issues:write')

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
      <div className="space-y-4">
        <EmptyState
          icon={<Target strokeWidth={1.75} />}
          title={t('noProjectsTitle')}
          hint={t('noProjectsHint')}
        />
        {canEdit && (
          <div className="flex justify-center">
            <AddInitiativeProjectsButton initiativeId={id} candidates={candidates} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {canEdit && (
        <div className="flex justify-end">
          <AddInitiativeProjectsButton initiativeId={id} candidates={candidates} />
        </div>
      )}
      {grouped.map((group) => (
        <section key={group.status} className="space-y-2">
          <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
            {tracker(`projectStatus.${group.status}`)} · {group.items.length}
          </p>
          <div className="space-y-2">
            {group.items.map((project) => (
              <div
                key={project.id}
                className="flex items-center gap-1 rounded-lg border bg-card pr-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <Link
                  href={`/${workspace}/project/${encodeURIComponent(project.id)}`}
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-3 px-3.5 py-2.5"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] font-[510] text-foreground">
                    {project.name}
                    {/* A project that rolled up through a sub-goal has to say what it hangs from, so the remaining work points at the actual
                      place rather than at the umbrella. */}
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
                {/* A project that rolled up through a sub-goal hangs from THAT goal rather than here — no pretence that it can be removed
                  from here. */}
                {canEdit && project.viaInitiativeId === undefined && (
                  <RemoveInitiativeProjectButton
                    initiativeId={id}
                    projectId={project.id}
                    projectName={project.name}
                  />
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
