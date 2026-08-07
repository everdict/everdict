import { redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { RegisterJudgeForm, type JudgeFormInitial } from '@/features/register-judge'
import { judgeSpecSchema, judgesSchema } from '@/entities/judge'
import { modelSpecSchema, modelsSchema } from '@/entities/model'
import { runtimesSchema } from '@/entities/runtime'
import { traceSourcesResponseSchema, type TraceSourceConfig } from '@/entities/trace-source'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { bumpSemver, maxSemver, sortSemverDesc } from '@/shared/lib/semver'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// New judge version — versions are immutable, so "edit = new version". The wizard is the register form
// prefilled with the base version's spec, the id locked and a patch bump suggested. Code is the ONLY
// authoring surface: a legacy model/harness base prefills id/description and the new version is written
// as a code judge (the diff page flags the kind change).
export default async function NewJudgeVersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ v?: string }>
}) {
  const { workspace, id } = await params
  const { v } = await searchParams
  const t = await getTranslations('judgesPage')
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'judges:write')

  // Base spec — the ?v= version if it exists, else the latest. Back to the list when the judge is gone.
  let summary
  try {
    summary = judgesSchema.parse(await controlPlane.listJudges(ctx)).find((j) => j.id === id)
  } catch {
    summary = undefined
  }
  if (!summary) redirect(`/${workspace}/judges`)

  let initial: JudgeFormInitial | undefined
  let baseKind: string | undefined
  let loadError: string | undefined
  try {
    const versions = sortSemverDesc(summary.versions)
    const active =
      (typeof v === 'string' && summary.versions.includes(v) ? v : undefined) ?? versions[0]
    if (!active) throw new Error(t('noVersions'))
    const base = judgeSpecSchema.parse(await controlPlane.getJudge(ctx, id, active))
    const suggested = bumpSemver(maxSemver(summary.versions) ?? active, 'patch')
    baseKind = base.kind
    initial = {
      id: base.id,
      version: suggested,
      ...(base.description !== undefined ? { description: base.description } : {}),
      ...(base.kind === 'code'
        ? {
            language: base.language === 'node' ? ('node' as const) : ('python' as const),
            ...(base.code !== undefined ? { code: base.code } : {}),
            // Only a registered-Model ref prefills — the picker offers refs, not raw model strings.
            ...(typeof base.model === 'object' && base.model !== null
              ? { model: base.model.ref }
              : {}),
            ...(base.runtime !== undefined ? { runtime: base.runtime } : {}),
            ...(base.image !== undefined ? { image: base.image } : {}),
            ...(base.timeoutSec !== undefined ? { timeoutSec: String(base.timeoutSec) } : {}),
          }
        : {}),
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e)
  }

  // The same supporting data the register page loads — all best-effort, the form renders without them.
  let runtimes: { id: string }[] = []
  if (allowed) {
    try {
      runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
    } catch {
      runtimes = []
    }
  }

  type PickModel = { id: string; provider: string; model: string }
  let models: PickModel[] = []
  if (allowed) {
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
  }

  let sources: TraceSourceConfig[] = []
  let assignments: Record<string, string> = {}
  if (allowed) {
    try {
      const roster = traceSourcesResponseSchema.parse(await controlPlane.listTraceSources(ctx))
      sources = roster.sources
      assignments = roster.assignments
    } catch {
      sources = []
      assignments = {}
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/${workspace}/judge/${encodeURIComponent(id)}`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {id}
        </Link>
        <PageHeader title={t('newVersion')} description={t('newVersionDescription', { id })} />
      </div>
      {!allowed ? (
        <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
      ) : loadError || !initial ? (
        <Callout tone="danger">
          {t('loadError', { detail: loadError ? `: ${loadError}` : '' })}
        </Callout>
      ) : (
        <div className="max-w-3xl space-y-4">
          {baseKind !== undefined && baseKind !== 'code' && (
            <Callout tone="info">{t('newVersionKindNotice', { kind: baseKind })}</Callout>
          )}
          <Card className="p-5">
            <RegisterJudgeForm
              workspace={workspace}
              runtimes={runtimes}
              models={models}
              sources={sources}
              assignments={assignments}
              initial={initial}
              lockId
              redirectDetailId={id}
            />
          </Card>
        </div>
      )}
    </div>
  )
}
