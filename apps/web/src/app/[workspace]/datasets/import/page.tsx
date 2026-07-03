import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

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
  const allowed = can(principal?.roles, 'datasets:write')

  let benchmarks: BenchmarkCatalogItem[] = []
  let recipes: RecipeItem[] = []
  // 시스템 관리 버저닝: 기존 데이터셋 id→versions 를 위저드/가져오기 폼에 넘겨 다음 semver 를 제안.
  let existingDatasets: { id: string; versions: string[] }[] = []
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
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/datasets`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        데이터셋
      </Link>
      <PageHeader
        title="벤치마크 가져오기"
        description="HuggingFace나 JSONL에서 바로 벤치마크를 만들어요. 공개 카탈로그에서 가져올 수도 있어요."
      />
      {!allowed ? (
        <EmptyState
          title="추가 권한이 없어요."
          hint="워크스페이스 관리자에게 권한을 요청해보세요."
        />
      ) : error ? (
        <Callout tone="danger">카탈로그를 불러오지 못했어요: {error}</Callout>
      ) : (
        <Card className="p-5">
          <AddBenchmark
            benchmarks={benchmarks}
            recipes={recipes}
            existingDatasets={existingDatasets}
            preselectRecipe={preselectRecipe}
          />
        </Card>
      )}
    </div>
  )
}
