import Link from 'next/link'
import { ChevronLeft, ScrollText } from 'lucide-react'

import { RegisterRecipeForm } from '@/features/register-benchmark-recipe'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

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
    <div className="space-y-7">
      <div className="space-y-3">
        <Link
          href="/dashboard/datasets"
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          데이터셋
        </Link>
        <PageHeader
          title="벤치마크 레시피"
          description="재사용 가능한 벤치마크 정의(source + mapping + 채점)를 이 워크스페이스에 데이터로 등록합니다. 등록한 레시피는 '벤치마크 추가'에서 데이터셋으로 인입할 수 있습니다."
        />
      </div>

      <section className="space-y-2.5">
        <SectionHeader title={`레시피 (${recipes.length})`} />
        {error ? (
          <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
        ) : recipes.length === 0 ? (
          <EmptyState
            icon={<ScrollText />}
            title="등록된 레시피가 없습니다."
            hint="아래에서 레시피(JSON)를 등록하세요."
          />
        ) : (
          <div className="space-y-2">
            {recipes.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border">
                    <ScrollText className="size-[18px]" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 space-y-1.5">
                    <div className="truncate text-[13px] font-[560] text-foreground">{r.id}</div>
                    <div className="flex flex-wrap gap-1">
                      {r.versions.map((v) => (
                        <code
                          key={v}
                          className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border"
                        >
                          {v}
                        </code>
                      ))}
                    </div>
                  </div>
                </div>
                <Badge tone={r.owner === principal?.workspace ? 'success' : 'neutral'}>
                  {r.owner === principal?.workspace ? 'owned' : 'shared'}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2.5">
        <SectionHeader title="레시피 등록" />
        {allowed ? (
          <Card className="p-5">
            <RegisterRecipeForm />
          </Card>
        ) : (
          <EmptyState
            title="레시피 등록 권한이 없습니다."
            hint="member 이상 역할이 필요합니다(datasets:write)."
          />
        )}
      </section>
    </div>
  )
}
