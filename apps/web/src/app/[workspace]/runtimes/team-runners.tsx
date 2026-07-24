'use client'

import { useRouter } from 'next/navigation'

import { WorkspaceRunnersManager } from '@/features/manage-workspace-runners'
import type { GithubAppView } from '@/entities/github-app'
import type { RunnerMeta } from '@/entities/runner'

// Client wrapper for the Runtimes-page "Team runners" section. Supplies the manager's "install/manage GitHub App"
// CTA (routes to the Integrations settings drill-in) and hides the manager's own heading — the host <Section>
// provides the title/description, so the manager renders only the action buttons + roster.
export function TeamRunnersSection({
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
      workspace={workspace}
      showHeader={false}
      onOpenIntegrations={() => router.push(`/${workspace}/settings/integrations?app=github`)}
    />
  )
}
