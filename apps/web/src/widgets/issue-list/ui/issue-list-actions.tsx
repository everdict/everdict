import { getTranslations } from 'next-intl/server'
import { z } from 'zod'

import {
  ImportGithubIssuesButton,
  PullGithubIssuesButton,
  type SyncedRepository,
} from '@/features/import-github-issues'
import { CreateIssueButton } from '@/features/manage-issue'
import { githubAppRepoSchema } from '@/entities/github-app'
import { issuePageSchema, type IssueSummary } from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Link } from '@/shared/ui/link'
import { Skeleton } from '@/shared/ui/skeleton'

// The cap for building the synced-repository list. The aim is to COUNT repository names, so one page is enough.
const MAX_SYNCED_ROSTER = 200

// The list header's write buttons — "import", "pull" and "new issue".
//
// These three are their own component because of **waiting** rather than rendering. Drawing three buttons requires the GitHub App installation
// state plus the synced-repository list (200 issue rows) plus the team list, and those three used to be bound into the same `Promise.all` as
// the list: fifty issue rows had already arrived and the whole screen stood still because the toolbar had not. Now this component streams
// behind a Suspense boundary and the list waits only for its own data.
export async function IssueListActions({
  workspace,
  projects,
  canReadIntegrations,
}: {
  workspace: string
  projects: { id: string; name: string }[]
  // The import picker reads the workspace App's repo list (github:read, member+) — the entry point is only
  // offered to someone who can actually complete the flow.
  canReadIntegrations: boolean
}) {
  const t = await getTranslations('issuesPage')
  const ctx = await authContext()

  const [githubConnected, syncedRoster] = await Promise.all([
    // "Is GitHub connected?" is asked through the REPO list, not the installation view: the installation view is
    // App administration (settings:read, admin-only), so a member asking it got a silent false from the catch and
    // an import entry point that claimed nothing was connected. The repo list answers the same question with the
    // read the import flow itself uses (github:read) — and repos, not installations, are what can be imported from.
    controlPlane
      .getGithubAppRepos(ctx)
      .then((r) => z.array(githubAppRepoSchema).parse(r).length > 0)
      .catch(() => false),
    // A bulk pull is per repository, so the button offers only repositories with something to refresh. The narrowing is the SERVER's
    // (`syncPull`) — this used to re-read the entire unfiltered issue list and filter here, reading the whole table again just to name a few
    // repositories.
    controlPlane
      .listIssues(ctx, {
        syncPull: true,
        limit: MAX_SYNCED_ROSTER,
      })
      .then((r) => issuePageSchema.parse(r).items)
      .catch((): IssueSummary[] => []),
  ])

  const syncedRepositories: SyncedRepository[] = []
  for (const issue of syncedRoster) {
    const github = issue.github
    if (!github || !github.pull) continue
    const existing = syncedRepositories.find(
      (r) => r.repository === github.repository && r.host === github.host
    )
    if (existing) existing.issues += 1
    else
      syncedRepositories.push({
        repository: github.repository,
        ...(github.host ? { host: github.host } : {}),
        issues: 1,
      })
  }

  // The team a new issue first lands in: the team whose list it was opened from, else the workspace's default team. So an issue is never
  // created somewhere it will not appear in the list being looked at.

  return (
    <div className="flex flex-wrap items-center gap-2">
      <PullGithubIssuesButton repositories={syncedRepositories} />
      {githubConnected ? (
        <ImportGithubIssuesButton workspace={workspace} projects={projects} />
      ) : (
        // Never a dead import button: with no reachable installation the only useful move is connecting
        // the App, so link there instead of opening a picker that has nothing to show.
        canReadIntegrations && (
          <Link
            href={`/${workspace}/settings/integrations`}
            className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('connectGithub')}
          </Link>
        )
      )}
      <CreateIssueButton
        workspace={workspace}
        projects={projects}
      />
    </div>
  )
}

// The placeholder before the toolbar arrives. It reserves the same height so buttons appearing late do not push the title line.
export function IssueListActionsSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-8 w-28" />
    </div>
  )
}
