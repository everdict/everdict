import type { Project } from '@/entities/project'

// A project joins a goal by naming it — the link lives on the PROJECT (`initiativeIds`), because one project
// routinely serves two goals. So "which projects can I add here" is the workspace's projects minus the ones that
// already name this initiative, and adding one is an edit to that project rather than a new kind of record.
//
// A cancelled project is dropped: pulling abandoned work under a goal says nothing about reaching it, and the
// picker exists to answer "what else counts toward this", not "what has ever existed".
export function projectCandidatesFor(
  initiativeId: string,
  projects: readonly Project[]
): Project[] {
  return projects
    .filter((project) => !project.initiativeIds.includes(initiativeId))
    .filter((project) => project.status !== 'cancelled')
}
