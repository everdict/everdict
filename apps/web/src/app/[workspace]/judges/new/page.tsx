import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { RegisterJudgeForm } from '@/features/register-judge'
import { modelSpecSchema, modelsSchema } from '@/entities/model'
import { rubricsSchema } from '@/entities/rubric'
import { runtimesSchema } from '@/entities/runtime'
import { traceSourcesResponseSchema, type TraceSourceConfig } from '@/entities/trace-source'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewJudgePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('judgesPage')
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'judges:write')

  // For the harness judge's runtime selector — the form renders even on failure (empty = co-locate/default only).
  let runtimes: { id: string }[] = []
  try {
    runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
  } catch {
    runtimes = []
  }

  // For the registered-rubric selector — the form renders even on failure (empty = inline mode still works).
  let rubrics: { id: string; owner: string }[] = []
  try {
    rubrics = rubricsSchema.parse(await controlPlane.listRubrics(ctx))
  } catch {
    rubrics = []
  }

  // For the model-judge model picker — registered models with their provider + underlying model string (id ≠ model).
  // Best-effort per-model spec fetch (the list summary carries only ids); empty = the form falls back to a free-text model input.
  type PickModel = { id: string; provider: string; model: string }
  let models: PickModel[] = []
  try {
    const summaries = modelsSchema.parse(await controlPlane.listModels(ctx))
    const specs = await Promise.all(
      summaries.map(async (m): Promise<PickModel | null> => {
        try {
          const s = modelSpecSchema.parse(await controlPlane.getModel(ctx, m.id, 'latest'))
          return { id: s.id, provider: s.provider, model: s.model }
        } catch {
          return null
        }
      })
    )
    models = specs.filter((s): s is PickModel => s !== null)
  } catch {
    models = []
  }

  // For the preview panel's sample-trace picker — the workspace's registered trace sources + per-harness selections
  // (used to reverse-look-up which harness a conversion mapping should save onto). Empty = manual JSON paste only.
  let sources: TraceSourceConfig[] = []
  let assignments: Record<string, string> = {}
  try {
    const roster = traceSourcesResponseSchema.parse(await controlPlane.listTraceSources(ctx))
    sources = roster.sources
    assignments = roster.assignments
  } catch {
    sources = []
    assignments = {}
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/${workspace}/judges`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {t('title')}
        </Link>
        <PageHeader title={t('register')} description={t('registerDescription')} />
      </div>
      {allowed ? (
        <Card className="p-5">
          <RegisterJudgeForm
            workspace={workspace}
            runtimes={runtimes}
            rubrics={rubrics}
            models={models}
            sources={sources}
            assignments={assignments}
          />
        </Card>
      ) : (
        <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
      )}
    </div>
  )
}
