'use client'

import { useRouter } from 'next/navigation'

import { WorkspaceRunnersManager } from '@/features/manage-workspace-runners'
import type { GithubAppView } from '@/entities/github-app'
import type { RunnerMeta } from '@/entities/runner'

// Client wrapper — converts the manager's "install/manage GitHub App" CTA (previously a same-page tab switch)
// into navigation to the Integrations page's GitHub drill-in, now that each settings section is its own route.
export function RunnersSection({
  workspace,
  runners,
  canWrite,
  githubApp,
}: {
  workspace: string
  runners: RunnerMeta[]
  canWrite: boolean
  githubApp: GithubAppView
}) {
  const router = useRouter()
  return (
    <WorkspaceRunnersManager
      runners={runners}
      canWrite={canWrite}
      githubApp={githubApp}
      onOpenIntegrations={() => router.push(`/${workspace}/settings/integrations?app=github`)}
    />
  )
}
