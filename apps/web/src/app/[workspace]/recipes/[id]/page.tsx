import Link from 'next/link'
import { ChevronLeft, Database, ScrollText } from 'lucide-react'

import { recipeListSchema, recipeSpecSchema, type RecipeSpec } from '@/entities/benchmark-recipe'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { maxSemver, sortSemverDesc } from '@/shared/lib/semver'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

export const dynamic = 'force-dynamic'

function BackLink({ workspace }: { workspace: string }) {
  return (
    <Link
      href={`/${workspace}/recipes`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      레시피
    </Link>
  )
}

// mapping 값 표기 — 문자열은 그대로, 배열/객체는 JSON.
function fmtVal(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v)
}

export default async function RecipeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ v?: string }>
}) {
  const { workspace, id } = await params
  const { v } = await searchParams
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'datasets:write')

  let versions: string[] = []
  let owner: string | undefined
  let spec: RecipeSpec | undefined
  let error: string | undefined
  try {
    const list = recipeListSchema.parse(await controlPlane.listBenchmarkRecipes(ctx))
    const item = list.find((r) => r.id === id)
    if (!item) throw new Error(`레시피 '${id}' 를 찾을 수 없습니다.`)
    versions = sortSemverDesc(item.versions)
    owner = item.owner
    const version = v && item.versions.includes(v) ? v : (maxSemver(item.versions) ?? versions[0])
    if (!version) throw new Error('버전이 없습니다.')
    spec = recipeSpecSchema.parse(await controlPlane.getBenchmarkRecipe(ctx, id, version))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!spec) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} />
        <PageHeader title={<span className="font-mono">{id}</span>} />
        <Callout tone="danger">레시피를 불러올 수 없습니다: {error}</Callout>
      </div>
    )
  }

  const owned = owner === principal?.workspace
  const src = spec.source
  const mappingEntries = Object.entries(spec.mapping)

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} />
        <PageHeader
          title={<span className="font-mono">{spec.id}</span>}
          description={
            spec.description ?? '벤치마크 레시피 — source + mapping 으로 데이터셋을 생성.'
          }
          actions={
            allowed ? (
              <Link
                href={`/${workspace}/datasets/import?recipe=${encodeURIComponent(spec.id)}`}
                className={buttonVariants({ size: 'sm' })}
              >
                데이터셋으로 만들기
              </Link>
            ) : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">{spec.category}</Badge>
          <Badge tone={owned ? 'success' : 'neutral'}>{owned ? 'owned' : 'shared'}</Badge>
          <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-inset ring-border">
            {src.kind}
          </code>
        </div>
      </div>

      {/* 관계 설명 — 레시피 → 데이터셋 → (하니스) 평가. 엔터티 위계를 명시. */}
      <Card className="flex flex-wrap items-center gap-x-2 gap-y-1 p-3.5 text-[12px] text-muted-foreground">
        <ScrollText className="size-4 text-foreground" />
        <span className="font-[510] text-foreground">레시피</span>
        <span className="text-faint">— source+mapping →</span>
        <Database className="size-4 text-foreground" />
        <span className="font-[510] text-foreground">데이터셋</span>
        <span className="text-faint">— 하니스로 평가 → 스코어카드.</span>
        <span>이 레시피는 재사용 틀이며, 인입할 때마다 버전 고정 데이터셋을 만듭니다.</span>
      </Card>

      {versions.length > 1 && (
        <section className="space-y-2.5">
          <SectionHeader title="버전" />
          <div className="flex flex-wrap gap-1.5">
            {versions.map((ver) => (
              <Link
                key={ver}
                href={`/${workspace}/recipes/${encodeURIComponent(spec.id)}?v=${encodeURIComponent(ver)}`}
                className={cn(
                  'rounded-md border px-2 py-1 font-mono text-[11px] tabular-nums transition-colors',
                  ver === spec.version
                    ? 'border-border-strong bg-elevated text-foreground'
                    : 'text-muted-foreground hover:bg-elevated hover:text-foreground'
                )}
              >
                {ver}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2.5">
        <SectionHeader title="소스" />
        <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
          <Prop label="kind" value={src.kind} />
          {src.dataset ? <Prop label="dataset" value={src.dataset} /> : null}
          {src.config ? <Prop label="config" value={src.config} /> : null}
          {src.split ? <Prop label="split" value={src.split} /> : null}
          {src.gated != null ? <Prop label="gated" value={src.gated ? 'yes' : 'no'} /> : null}
        </Card>
        {src.kind === 'jsonl' && (
          <p className="text-[12px] text-muted-foreground">
            JSONL 소스 — 데이터셋으로 만들 때 행(JSONL) 텍스트를 함께 제공해야 합니다.
          </p>
        )}
      </section>

      <section className="space-y-2.5">
        <SectionHeader title={`매핑 (${mappingEntries.length})`} />
        {mappingEntries.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">매핑이 없습니다.</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>케이스 필드</TH>
                <TH>소스 필드 / 값</TH>
              </tr>
            </THead>
            <TBody>
              {mappingEntries.map(([k, val]) => (
                <TR key={k}>
                  <TD className="font-mono text-[12px] font-[510]">{k}</TD>
                  <TD className="font-mono text-[12px] text-muted-foreground">{fmtVal(val)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      {spec.graderTemplates && spec.graderTemplates.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={`채점 템플릿 (${spec.graderTemplates.length})`} />
          <div className="space-y-2">
            {spec.graderTemplates.map((g, i) => (
              <Card key={`${g.id}-${i}`} className="space-y-2 p-3.5">
                <code className="font-mono text-[12px] font-[560]">{g.id}</code>
                {g.config && Object.keys(g.config).length > 0 && (
                  <pre className="overflow-x-auto rounded-md bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground ring-1 ring-inset ring-border">
                    {JSON.stringify(g.config, null, 2)}
                  </pre>
                )}
              </Card>
            ))}
          </div>
        </section>
      )}

      {!allowed && (
        <EmptyState
          title="이 레시피로 데이터셋을 만들려면 권한이 필요합니다."
          hint="member 이상 역할이 필요합니다(datasets:write)."
        />
      )}
    </div>
  )
}

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">{label}</dt>
      <dd className="mt-1 truncate font-mono text-[13px] text-foreground">{value}</dd>
    </div>
  )
}
