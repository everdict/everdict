import Link from 'next/link'
import { Server } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { RunnersManager } from '@/features/manage-runners'
import { githubAppViewSchema, type GithubAppView } from '@/entities/github-app'
import { runnersResponseSchema, type RunnerMeta } from '@/entities/runner'
import { runtimesSchema } from '@/entities/runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { TeamRunnersSection } from './team-runners'

export const dynamic = 'force-dynamic'

// Section title + one-line description — distinguishes the execution-target axes (registered infra / my machine / team runners).
function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2.5">
      <div className="space-y-1">
        <h2 className="text-[14px] font-[560] tracking-[-0.01em] text-foreground">{title}</h2>
        <p className="text-[12px] text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  )
}

// Runtimes — the single surface for "where evaluations run", consolidating all three execution targets:
// ① Registered infra (push: docker/nomad/k8s/topology the control plane connects to — workspace-owned)
// ② My machine (pull: personal self-hosted runner — a personally-owned device pulls jobs via lease)
// ③ Team runners (pull: workspace-owned self-hosted runners — shared build servers / CI, admin-managed).
// Consolidating ③ here (it used to live in Settings › Runners) makes "a runner" read as one flavor of runtime.
export default async function RuntimesPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('runtimesPage')
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let runtimes = runtimesSchema.parse([])
  try {
    runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // Self-hosted runners — personally owned, so no role gate; queries only the caller's (subject) runners. Renders the page even on failure (empty list).
  let runners: RunnerMeta[] = []
  try {
    runners = runnersResponseSchema.parse(await controlPlane.listRunners(ctx)).runners
  } catch {
    // Control-plane runner service unconfigured/failed — fall back to an empty list.
  }

  // Team shared runners — workspace-owned (build servers / CI). Admin-managed, so fetched only for admins (the
  // owned-roster read + GitHub-App snapshot are settings:write-gated); members target the pool via the run form.
  const canManageTeam = can(principal?.roles, 'settings:write')
  let teamRunners: RunnerMeta[] = []
  let githubApp: GithubAppView = { installations: [], providers: { githubCom: false } }
  if (canManageTeam) {
    try {
      teamRunners = runnersResponseSchema.parse(
        await controlPlane.listWorkspaceOwnedRunners(ctx)
      ).runners
      githubApp = githubAppViewSchema.parse(await controlPlane.getGithubApp(ctx))
    } catch {
      // Runner / GitHub-App service unconfigured — fall back to empty; the section still renders.
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Link href={`/${workspace}/runtimes/new`} className={buttonVariants({ size: 'sm' })}>
            {t('register')}
          </Link>
        }
      />

      <Section
        title={t('registeredInfra', { count: runtimes.length })}
        description={t('registeredInfraDescription')}
      >
        {error ? (
          <Callout tone="danger">{t('connectError', { error })}</Callout>
        ) : runtimes.length === 0 ? (
          <EmptyState
            icon={<Server strokeWidth={1.75} />}
            title={t('emptyInfraTitle')}
            hint={t('emptyInfraHint')}
          />
        ) : (
          <div className="space-y-2">
            {runtimes.map((r) => (
              <Link
                key={r.id}
                href={`/${workspace}/runtimes/${encodeURIComponent(r.id)}`}
                className="flex h-[52px] items-center gap-3 rounded-lg border bg-card px-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <Server className="size-4 shrink-0 text-[#6ec6a8]" />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-[510]">
                  {r.id}
                </span>
                <Badge tone={r.owner === '_shared' ? 'info' : 'neutral'}>
                  {r.owner === '_shared' ? t('sharedBadge') : t('workspaceBadge')}
                </Badge>
                <span className="w-[76px] text-right text-[12px] text-muted-foreground">
                  {t('versionCount', { count: r.versions.length })}
                </span>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('myMachine')} description={t('myMachineDescription')}>
        <RunnersManager
          runners={runners}
          downloadHref={`/${workspace}/download`}
          workspace={workspace}
        />
      </Section>

      {canManageTeam && (
        <Section title={t('teamRunners')} description={t('teamRunnersDescription')}>
          <TeamRunnersSection
            workspace={workspace}
            runners={teamRunners}
            canWrite={canManageTeam}
            githubApp={githubApp}
          />
        </Section>
      )}
    </div>
  )
}
