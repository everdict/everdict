import Link from 'next/link'
import { ScrollText } from 'lucide-react'

import { RegisterRecipeForm } from '@/features/register-benchmark-recipe'
import { recipeListSchema, recipeSpecSchema, type RecipeSpec } from '@/entities/benchmark-recipe'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { maxSemver } from '@/shared/lib/semver'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

export default async function RecipesPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'datasets:write')

  let recipes: { id: string; owner: string; versions: string[]; spec?: RecipeSpec }[] = []
  let error: string | undefined
  try {
    const list = recipeListSchema.parse(await controlPlane.listBenchmarkRecipes(ctx))
    // 각 레시피의 최신 스펙을 곁들여 카드에 category/source 를 노출(실패해도 경량 카드로 저하).
    recipes = await Promise.all(
      list.map(async (r) => {
        const latest = maxSemver(r.versions) ?? r.versions[r.versions.length - 1]
        if (!latest) return r
        try {
          const spec = recipeSpecSchema.parse(
            await controlPlane.getBenchmarkRecipe(ctx, r.id, latest)
          )
          return { ...r, spec }
        } catch {
          return r
        }
      })
    )
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-7">
      <PageHeader
        title="벤치마크 레시피"
        description="벤치마크 정의(source + mapping + 채점)를 재사용 가능한 데이터로 등록·버전관리하는 엔터티. 레시피를 데이터셋으로 인입하면 하니스로 평가할 수 있습니다."
      />

      <section className="space-y-2.5">
        <SectionHeader title={`레시피 (${recipes.length})`} />
        {error ? (
          <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
        ) : recipes.length === 0 ? (
          <EmptyState
            icon={<ScrollText />}
            title="등록된 레시피가 없습니다."
            hint="아래에서 레시피(JSON)를 등록하거나, 번들 적용으로 한 번에 받을 수 있습니다."
          />
        ) : (
          <div className="space-y-2">
            {recipes.map((r) => {
              const owned = r.owner === principal?.workspace
              return (
                <Link
                  key={r.id}
                  href={`/${workspace}/recipes/${encodeURIComponent(r.id)}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border">
                      <ScrollText className="size-[18px]" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-[560] text-foreground">
                          {r.id}
                        </span>
                        {r.spec ? <Badge tone="info">{r.spec.category}</Badge> : null}
                        {r.spec ? (
                          <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                            {r.spec.source.kind}
                            {r.spec.source.dataset ? ` · ${r.spec.source.dataset}` : ''}
                          </code>
                        ) : null}
                      </div>
                      {r.spec?.description ? (
                        <p className="truncate text-[12px] text-muted-foreground">
                          {r.spec.description}
                        </p>
                      ) : null}
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
                  <Badge tone={owned ? 'success' : 'neutral'}>{owned ? 'owned' : 'shared'}</Badge>
                </Link>
              )
            })}
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
