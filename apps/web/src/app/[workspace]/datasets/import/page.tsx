import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import {
  AddBenchmark,
  type BenchmarkCatalogItem,
  type RecipeItem,
} from '@/features/import-benchmark'
import { ImportTerminalBenchForm } from '@/features/import-terminal-bench'
import { datasetsSchema } from '@/entities/dataset'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function ImportBenchmarkPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ recipe?: string }>
}) {
  const { workspace } = await params
  const { recipe: preselectRecipe } = await searchParams
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('datasetsPage')
  const allowed = can(principal?.roles, 'datasets:write')

  let benchmarks: BenchmarkCatalogItem[] = []
  let recipes: RecipeItem[] = []
  // System-managed versioning: pass existing dataset id→versions to the wizard/import form to suggest the next semver.
  let existingDatasets: { id: string; versions: string[] }[] = []
  // Scope of the HF_TOKEN used for gated HF authentication — my (personal) secret first, workspace-shared fallback (same precedence as server resolution).
  // The list carries only name/scope (no value). The wizard works even if it fails (just displayed as not held).
  let hfTokenScope: 'user' | 'workspace' | undefined
  let error: string | undefined
  if (allowed) {
    try {
      benchmarks = await controlPlane.listBenchmarks<BenchmarkCatalogItem[]>(ctx)
      recipes = await controlPlane.listBenchmarkRecipes<RecipeItem[]>(ctx)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    try {
      existingDatasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
    } catch {
      existingDatasets = []
    }
    try {
      const secrets = await controlPlane.listSecrets<Array<{ name: string; scope?: string }>>(ctx)
      const hf = secrets.filter((s) => s.name === 'HF_TOKEN')
      if (hf.some((s) => s.scope === 'user')) hfTokenScope = 'user'
      else if (hf.length > 0) hfTokenScope = 'workspace'
    } catch {
      hfTokenScope = undefined
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/datasets`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('backToList')}
      </Link>
      <PageHeader title={t('importTitle')} description={t('importDescription')} />
      {!allowed ? (
        <EmptyState title={t('importNoPermTitle')} hint={t('noPermHint')} />
      ) : error ? (
        <Callout tone="danger">{t('catalogLoadError', { error })}</Callout>
      ) : (
        <>
          <Card className="p-5">
            <AddBenchmark
              benchmarks={benchmarks}
              recipes={recipes}
              existingDatasets={existingDatasets}
              preselectRecipe={preselectRecipe}
              {...(hfTokenScope ? { hfTokenScope } : {})}
            />
          </Card>
          {/* Standard task-format on-ramp — bring an existing Terminal-Bench task set (directory/container tasks the
              row-based wizard above can't express). docs/architecture/standard-task-formats.md */}
          <Card className="space-y-4 p-5">
            <div>
              <h2 className="text-[14px] font-[560] tracking-[-0.01em]">{t('tbTitle')}</h2>
              <p className="text-[12px] text-muted-foreground">{t('tbSubtitle')}</p>
            </div>
            <ImportTerminalBenchForm />
          </Card>
        </>
      )}
    </div>
  )
}
