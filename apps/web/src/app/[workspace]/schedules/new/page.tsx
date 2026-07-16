import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CreateScheduleForm } from '@/features/create-schedule'
import { datasetsSchema } from '@/entities/dataset'
import { harnessesSchema } from '@/entities/harness'
import { judgesSchema } from '@/entities/judge'
import { runnersResponseSchema } from '@/entities/runner'
import { runtimesSchema } from '@/entities/runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewSchedulePage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const t = await getTranslations('schedulesPage')
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'schedules:write')

  let datasets: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[] = []
  let harnesses: {
    id: string
    versions: string[]
    versionTags?: Record<string, string[]>
    kind?: string
  }[] = []
  let runtimes: { id: string; capabilities?: string[] }[] = []
  let judges: { id: string }[] = []
  let runners: { id: string; label: string }[] = []
  let hasWorkspaceRunners = false
  if (allowed) {
    try {
      datasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
      harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
      runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
    } catch {
      // Even if the list fails, the form still works (text / empty selection)
    }
    // Agent Judges — optional judges to score each fire's traces (→ judge:<id> metrics). Not shown if it fails/is empty.
    try {
      judges = judgesSchema.parse(await controlPlane.listJudges(ctx))
    } catch {
      // Even if the judge list fails, the form still works (judge picker empty)
    }
    // My local runner picker — personally-owned device. Not shown if it fails/is empty.
    try {
      runners = runnersResponseSchema.parse(await controlPlane.listRunners(ctx)).runners
    } catch {
      // Even if the runner list fails, the form still works
    }
    // If the workspace has team-shared runners, expose the self:ws pool option. Not shown if it fails/is empty.
    try {
      hasWorkspaceRunners =
        runnersResponseSchema.parse(await controlPlane.listWorkspaceRunners(ctx)).runners.length > 0
    } catch {
      // Even if the roster fails, the form still works (only the pool option is hidden)
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/schedules`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('title')}
      </Link>
      <PageHeader title={t('create')} description={t('createDescription')} />
      {allowed ? (
        <Card className="p-5">
          <CreateScheduleForm
            datasets={datasets}
            harnesses={harnesses}
            runtimes={runtimes}
            judges={judges}
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
