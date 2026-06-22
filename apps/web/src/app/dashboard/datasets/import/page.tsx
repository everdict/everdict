import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'

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

export default async function ImportBenchmarkPage() {
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
        href="/dashboard/datasets"
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        데이터셋
      </Link>
      <PageHeader
        title="벤치마크 추가"
        description="HF 데이터셋·JSONL 소스를 미리보기로 필드를 감지해 매핑하면 바로 데이터셋이 됩니다(소스에서 만들기). 또는 공개 카탈로그(WebVoyager·GAIA·SWE-bench…)·내 레시피에서 가져옵니다."
        actions={
          <Link
            href="/dashboard/datasets/recipes"
            className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
          >
            레시피 관리
            <ChevronRight className="size-3.5" />
          </Link>
        }
      />
      {!allowed ? (
        <EmptyState
          title="벤치마크 추가 권한이 없습니다."
          hint="member 이상 역할이 필요합니다(datasets:write). 워크스페이스 관리자에게 문의하세요."
        />
      ) : error ? (
        <Callout tone="danger">카탈로그 조회 실패: {error}</Callout>
      ) : (
        <Card className="p-5">
          <AddBenchmark
            benchmarks={benchmarks}
            recipes={recipes}
            existingDatasets={existingDatasets}
          />
        </Card>
      )}
    </div>
  )
}
