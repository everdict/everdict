import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { datasetsSchema } from '@/entities/dataset'
import { harnessesSchema } from '@/entities/harness'
import { judgesSchema, type JudgePickerChoice } from '@/entities/judge'
import { runnersResponseSchema } from '@/entities/runner'
import { runtimesSchema } from '@/entities/runtime'
import { ownerChoicesFor, teamsSchema, type OwnerChoices } from '@/entities/team'
import { traceSourcesResponseSchema, type TraceSourceConfig } from '@/entities/trace-source'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

import { ScorecardCreate } from './scorecard-create'

// Starting a batch evaluation — one address, `/{workspace}/scorecards/new`. By default the batch inherits the
// team that owns the harness chosen, so choosing what to run is also choosing whose result it is; the form's
// team field is the explicit override. (The team-pinned twin under `…/team/ENG/scorecards/new` is gone with
// the team eval axis.)
export async function ScorecardCreateView({ workspace }: { workspace: string }) {
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('scorecardsPage')
  const allowed = can(principal?.roles, 'scorecards:run')

  let datasets: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[] = []
  let harnesses: {
    id: string
    versions: string[]
    versionTags?: Record<string, string[]>
    kind?: string
  }[] = []
  let judges: JudgePickerChoice[] = []
  let runtimes: { id: string; capabilities?: string[] }[] = []
  let runners: { id: string; label: string }[] = []
  let hasWorkspaceRunners = false
  let traceSources: TraceSourceConfig[] = []
  // Owning-team choices for the batch (only teams the caller can create into). Empty = picker hidden.
  let ownerChoices: OwnerChoices = { teams: [] }
  if (allowed) {
    try {
      const teams = teamsSchema.parse(await controlPlane.listTeams(ctx))
      ownerChoices = ownerChoicesFor(principal, teams, 'scorecards:run')
    } catch {
      ownerChoices = { teams: [] }
    }
    try {
      datasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
      harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
    } catch {
      // Even if the list fails, the form still works (just empty choices)
    }
    // Agent Judges — optional model/harness judges to score each case's trace (→ judge:<id> metrics). Not shown if it fails/is empty.
    try {
      judges = judgesSchema.parse(await controlPlane.listJudges(ctx))
    } catch {
      // Even if the judge list fails, the form still works (judge picker just empty → control-plane default scoring)
    }
    // Runtime picker — where it runs is required (control-plane-host fallback is forbidden by policy). Registered runtimes + runner pools as choices.
    try {
      runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
    } catch {
      // Even if the runtime list fails, the form still works (just empty choices)
    }
    // My local runner picker — personally-owned device. Not shown if it fails/is empty.
    try {
      runners = runnersResponseSchema.parse(await controlPlane.listRunners(ctx)).runners
    } catch {
      // Even if the runner list fails, the form still works
    }
    // If the workspace has team-shared runners, expose the self:ws pool option (members:read roster). Not shown if it fails/is empty.
    try {
      hasWorkspaceRunners =
        runnersResponseSchema.parse(await controlPlane.listWorkspaceRunners(ctx)).runners.length > 0
    } catch {
      // Even if the roster fails, the form still works (only the pool option is hidden)
    }
    // Registered observability trace sources — the "evaluate existing traces" mode pulls a chosen set from one. Not shown if it fails/is empty.
    try {
      traceSources = traceSourcesResponseSchema.parse(
        await controlPlane.listTraceSources(ctx)
      ).sources
    } catch {
      // Even if the list fails, the run mode still works (the trace-eval tab just shows "register a source first")
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/scorecards`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('backToList')}
      </Link>
      <PageHeader title={t('run')} description={t('runDescription')} />
      {allowed ? (
        <ScorecardCreate
          datasets={datasets}
          harnesses={harnesses}
          judges={judges}
          runtimes={runtimes}
          runners={runners}
          hasWorkspaceRunners={hasWorkspaceRunners}
          traceSources={traceSources}
          teams={ownerChoices.teams}
          {...(ownerChoices.defaultTeamId !== undefined
            ? { defaultTeamId: ownerChoices.defaultTeamId }
            : {})}
        />
      ) : (
        <EmptyState title={t('noRunPermTitle')} hint={t('noPermHint')} />
      )}
    </div>
  )
}
