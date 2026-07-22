import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CreateScheduleForm } from '@/features/create-schedule'
import { CommentsSection } from '@/features/discuss'
import { datasetsSchema } from '@/entities/dataset'
import { harnessesSchema } from '@/entities/harness'
import { judgesSchema } from '@/entities/judge'
import { runnersResponseSchema } from '@/entities/runner'
import { runtimesSchema } from '@/entities/runtime'
import { scheduleSchema, type Schedule } from '@/entities/schedule'
import { traceSourcesResponseSchema, type TraceSourceConfig } from '@/entities/trace-source'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function EditSchedulePage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('schedulesPage')
  const { principal, ctx } = await currentPrincipal()

  let schedule: Schedule | null = null
  try {
    schedule = scheduleSchema.parse(await controlPlane.getSchedule(ctx, id))
  } catch {
    schedule = null // missing / other workspace (404) → go to the list
  }
  if (!schedule) redirect(`/${workspace}/schedules`)

  // Editing is for the creator or a workspace admin only (the control plane also enforces it — this is UI gating). Otherwise go to the list.
  const isAdmin = principal?.roles.includes('admin') ?? false
  const isCreator = principal?.subject === schedule.createdBy
  if (!isCreator && !isAdmin) redirect(`/${workspace}/schedules`)

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
  let traceSources: TraceSourceConfig[] = []
  try {
    datasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
    harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
    runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
  } catch {
    // Even if the list fails, the form still works (keeps the current values)
  }
  try {
    traceSources = traceSourcesResponseSchema.parse(
      await controlPlane.listTraceSources(ctx)
    ).sources
  } catch {
    // Even if the list fails, batch mode still works
  }
  try {
    judges = judgesSchema.parse(await controlPlane.listJudges(ctx))
  } catch {
    // Even if the judge list fails, the form still works
  }
  try {
    runners = runnersResponseSchema.parse(await controlPlane.listRunners(ctx)).runners
  } catch {
    // Even if the runner list fails, the form still works
  }
  try {
    hasWorkspaceRunners =
      runnersResponseSchema.parse(await controlPlane.listWorkspaceRunners(ctx)).runners.length > 0
  } catch {
    // Even if the roster fails, the form still works (only the pool option is hidden)
  }

  const tmpl = schedule.runTemplate
  // A pull (trace-evaluation) schedule has no dataset/harness — prefill the pull fields + mode instead. Batch is unchanged.
  const initial = tmpl.pull
    ? {
        mode: 'pull' as const,
        name: schedule.name,
        cron: schedule.cron,
        timezone: schedule.timezone,
        overlapPolicy: schedule.overlapPolicy,
        pullSource: tmpl.pull.source,
        pullScope: tmpl.pull.scope ?? '',
        pullWindowHours: String(tmpl.pull.windowHours),
      }
    : {
        mode: 'batch' as const,
        name: schedule.name,
        cron: schedule.cron,
        timezone: schedule.timezone,
        overlapPolicy: schedule.overlapPolicy,
        datasetId: tmpl.dataset?.id ?? '',
        datasetVersion: tmpl.dataset?.version ?? 'latest',
        harnessId: tmpl.harness?.id ?? '',
        harnessVersion: tmpl.harness?.version ?? 'latest',
        runtime: tmpl.runtime ?? '',
        concurrency: tmpl.concurrency != null ? String(tmpl.concurrency) : '',
        trials: tmpl.trials != null ? String(tmpl.trials) : '',
        caseLimit: tmpl.cases?.limit != null ? String(tmpl.cases.limit) : '',
        caseTags: (tmpl.cases?.tags ?? []).join(', '),
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
      <PageHeader title={t('edit')} description={t('editDescription', { name: schedule.name })} />
      <Card className="p-5">
        <CreateScheduleForm
          datasets={datasets}
          harnesses={harnesses}
          runtimes={runtimes}
          judges={judges}
          runners={runners}
          hasWorkspaceRunners={hasWorkspaceRunners}
          traceSources={traceSources}
          initial={initial}
          scheduleId={schedule.id}
          initialJudges={tmpl.judges}
        />
      </Card>

      <CommentsSection
        workspace={workspace}
        resourceType="schedule"
        resourceId={id}
        title={t('discuss')}
      />
    </div>
  )
}
