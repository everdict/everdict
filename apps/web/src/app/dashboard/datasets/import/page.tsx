import Link from 'next/link'

import {
  ImportBenchmarkForm,
  type BenchmarkCatalogItem,
  type RecipeItem,
} from '@/features/import-benchmark'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function ImportBenchmarkPage() {
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'datasets:write')

  let benchmarks: BenchmarkCatalogItem[] = []
  let recipes: RecipeItem[] = []
  let error: string | undefined
  if (allowed) {
    try {
      benchmarks = await controlPlane.listBenchmarks<BenchmarkCatalogItem[]>(ctx)
      recipes = await controlPlane.listBenchmarkRecipes<RecipeItem[]>(ctx)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard/datasets"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← 데이터셋
      </Link>
      <PageHeader
        title="벤치마크 추가"
        description="공개 벤치마크(WebVoyager · GAIA · SWE-bench · Mind2Web · GSM8K …) 또는 내가 등록한 레시피를 당겨 이 워크스페이스 데이터셋으로 등록합니다."
        actions={
          <Link
            href="/dashboard/datasets/recipes"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            레시피 관리 →
          </Link>
        }
      />
      {!allowed ? (
        <EmptyState
          title="벤치마크 추가 권한이 없습니다."
          hint="member 이상 역할이 필요합니다(datasets:write). 워크스페이스 관리자에게 문의하세요."
        />
      ) : error ? (
        <Card className="border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          카탈로그 조회 실패: {error}
        </Card>
      ) : (
        <Card className="p-6">
          <ImportBenchmarkForm benchmarks={benchmarks} recipes={recipes} />
        </Card>
      )}
    </div>
  )
}
