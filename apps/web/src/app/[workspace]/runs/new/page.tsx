import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { SubmitRunForm } from '@/features/submit-run'
import { harnessesSchema, type Harness } from '@/entities/harness'
import { runnersResponseSchema } from '@/entities/runner'
import { runtimesSchema } from '@/entities/runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewRunPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('runsPage')
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'runs:submit')

  let harnesses: Harness[] = []
  let runtimes: { id: string }[] = []
  let runners: { id: string; label: string }[] = []
  let hasWorkspaceRunners = false
  if (allowed) {
    try {
      harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
    } catch {
      // Even if the harness list fails, the form works with text input
    }
    // Runtime picker — registered runtimes (tenant-owned+_shared). Default backend only on failure/none.
    try {
      runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
    } catch {
      // Even if the runtime list fails, the form still works with the default backend
    }
    // My local-runner picker — personally-owned devices. Not shown on failure/absence.
    try {
      runners = runnersResponseSchema.parse(await controlPlane.listRunners(ctx)).runners
    } catch {
      // Even if the runner list fails, the form still works
    }
    // If the workspace has team-shared runners, show the self:ws pool option (members:read roster). Not shown on failure/absence.
    try {
      hasWorkspaceRunners =
        runnersResponseSchema.parse(await controlPlane.listWorkspaceRunners(ctx)).runners.length > 0
    } catch {
      // Even if the roster fails, the form still works (only hides the pool option)
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/runs`}
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        ← {t('title')}
      </Link>
      <PageHeader title={t('newRun')} description={t('newRunDescription')} />
      {allowed ? (
        <Card className="p-6">
          <SubmitRunForm
            harnesses={harnesses}
            runtimes={runtimes}
            runners={runners}
            hasWorkspaceRunners={hasWorkspaceRunners}
          />
        </Card>
      ) : (
        <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
      )}
    </div>
  )
}
