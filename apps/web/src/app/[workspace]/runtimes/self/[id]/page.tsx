import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { RunnerDetail } from '@/features/runner-detail'
import { runsSchema, type Run } from '@/entities/run'
import { runnersResponseSchema, type RunnerMeta } from '@/entities/runner'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Self-hosted runner detail — the runtime-detail equivalent for a device that pulls jobs (the user chose to fold
// self-hosted runners into the Runtimes section). Resolves the runner in the caller's PERSONAL roster first, then the
// WORKSPACE-shared roster; the scope decides the target prefix (self:<id> vs self:ws:<id>) and the revoke path.
export default async function RunnerDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('runnerDetail')
  const { ctx } = await currentPrincipal()

  // Personal first (self-scoped, no role gate), then the workspace roster (members:read — may 403 for a viewer).
  let runner: RunnerMeta | undefined
  let scope: 'personal' | 'workspace' = 'personal'
  try {
    runner = runnersResponseSchema
      .parse(await controlPlane.listRunners(ctx))
      .runners.find((r) => r.id === id)
  } catch {
    runner = undefined
  }
  if (!runner) {
    try {
      runner = runnersResponseSchema
        .parse(await controlPlane.listWorkspaceRunners(ctx))
        .runners.find((r) => r.id === id)
      if (runner) scope = 'workspace'
    } catch {
      runner = undefined
    }
  }
  if (!runner) redirect(`/${workspace}/runtimes`)

  // Recent runs this runner executed (provenance) — newest first, capped. Best-effort (empty on failure).
  let activity: Run[] = []
  try {
    activity = runsSchema.parse(await controlPlane.listRuns(ctx, { runner: id, limit: 30 }))
  } catch {
    activity = []
  }

  const target = scope === 'workspace' ? `self:ws:${id}` : `self:${id}`

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/runtimes`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('backToRuntimes')}
      </Link>
      <PageHeader title={runner.label} description={t('description')} />
      <RunnerDetail
        runner={runner}
        scope={scope}
        target={target}
        activity={activity}
        workspace={workspace}
        downloadHref={`/${workspace}/download`}
      />
    </div>
  )
}
