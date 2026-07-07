import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import {
  AddBenchmark,
  type BenchmarkCatalogItem,
  type RecipeItem,
} from '@/features/import-benchmark'
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
  // 시스템 관리 버저닝: 기존 데이터셋 id→versions 를 위저드/가져오기 폼에 넘겨 다음 semver 를 제안.
  let existingDatasets: { id: string; versions: string[] }[] = []
  // gated HF 인증에 쓸 HF_TOKEN 의 스코프 — 내(개인) 시크릿 우선, 워크스페이스 공유 폴백(서버 해석과 동일 우선순위).
  // 목록엔 이름/스코프만 온다(값 없음). 실패해도 위저드는 동작(표시만 미보유로).
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
        <Card className="p-5">
          <AddBenchmark
            benchmarks={benchmarks}
            recipes={recipes}
            existingDatasets={existingDatasets}
            preselectRecipe={preselectRecipe}
            {...(hfTokenScope ? { hfTokenScope } : {})}
          />
        </Card>
      )}
    </div>
  )
}
