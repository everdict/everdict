import Link from 'next/link'

import { RegisterRecipeForm } from '@/features/register-benchmark-recipe'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Card, CardContent } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

interface RecipeItem {
  id: string
  owner: string
  versions: string[]
}

export default async function RecipesPage() {
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'datasets:write')

  let recipes: RecipeItem[] = []
  let error: string | undefined
  try {
    recipes = await controlPlane.listBenchmarkRecipes<RecipeItem[]>(ctx)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
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
        title="벤치마크 레시피"
        description="재사용 가능한 벤치마크 정의(source + mapping + 채점)를 이 워크스페이스에 데이터로 등록합니다. 등록한 레시피는 '벤치마크 추가'에서 데이터셋으로 인입할 수 있습니다."
      />

      {error ? (
        <Card className="border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          컨트롤플레인 연결 실패: {error}
        </Card>
      ) : recipes.length === 0 ? (
        <EmptyState title="등록된 레시피가 없습니다." hint="아래에서 레시피(JSON)를 등록하세요." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {recipes.map((r) => (
            <Card key={r.id}>
              <CardContent className="space-y-2 pt-5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{r.id}</span>
                  <Badge tone={r.owner === principal?.workspace ? 'success' : 'neutral'}>
                    {r.owner === principal?.workspace ? 'owned' : 'shared'}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1">
                  {r.versions.map((v) => (
                    <code key={v} className="rounded-md bg-secondary px-1.5 py-0.5 text-xs">
                      {v}
                    </code>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {allowed ? (
        <Card className="p-6">
          <RegisterRecipeForm />
        </Card>
      ) : (
        <EmptyState
          title="레시피 등록 권한이 없습니다."
          hint="member 이상 역할이 필요합니다(datasets:write)."
        />
      )}
    </div>
  )
}
