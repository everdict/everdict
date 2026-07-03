import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { type RuntimeSpec, runtimeSpecSchema, runtimesSchema } from '@/entities/runtime'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { sortSemverDesc } from '@/shared/lib/semver'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// RuntimeSpec 의 kind별 설정 필드 → 표시용 라벨/값 행(값 있는 것만).
function specRows(spec: RuntimeSpec): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = []
  const add = (label: string, v: string | string[] | undefined) => {
    if (v === undefined) return
    if (Array.isArray(v)) {
      if (v.length > 0) rows.push({ label, value: v.join(', ') })
    } else {
      rows.push({ label, value: v })
    }
  }
  add('주소', spec.addr)
  add('데이터센터', spec.datacenters)
  add('Nomad 런타임', spec.runtime)
  add('K8s 컨텍스트', spec.context)
  add('RuntimeClass', spec.runtimeClass)
  add('이미지', spec.image)
  add('네임스페이스', spec.namespace)
  add('태그', spec.tags)
  return rows
}

export default async function RuntimeDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const { ctx } = await currentPrincipal()

  // 목록에서 이 런타임의 요약(버전/소유자) 확보 — 없거나 연결 실패면 목록으로.
  let summary: { id: string; owner: string; versions: string[] } | undefined
  try {
    summary = runtimesSchema.parse(await controlPlane.listRuntimes(ctx)).find((r) => r.id === id)
  } catch {
    summary = undefined
  }
  if (!summary) redirect(`/${workspace}/runtimes`)

  const versions = sortSemverDesc(summary.versions)
  const latest = versions[0] ?? summary.versions[0]
  let spec: RuntimeSpec | undefined
  let error: string | undefined
  try {
    spec = runtimeSpecSchema.parse(await controlPlane.getRuntime(ctx, id, latest))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const rows = spec ? specRows(spec) : []

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/runtimes`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        런타임
      </Link>
      <PageHeader title={id} description="평가를 실행하는 인프라예요." />
      {error || !spec ? (
        <Callout tone="danger">런타임을 불러오지 못했어요{error ? `: ${error}` : ''}.</Callout>
      ) : (
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info">{spec.kind}</Badge>
            <Badge tone={summary.owner === '_shared' ? 'info' : 'neutral'}>
              {summary.owner === '_shared' ? '공용' : '워크스페이스'}
            </Badge>
            <span className="font-mono text-[12px] text-faint">v{spec.version}</span>
          </div>
          {spec.description ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground">{spec.description}</p>
          ) : null}
          {rows.length > 0 ? (
            <div className="space-y-2 border-t border-border pt-4 text-[13px]">
              {rows.map((r) => (
                <div key={r.label} className="flex gap-4">
                  <span className="w-[128px] shrink-0 text-muted-foreground">{r.label}</span>
                  <span className="break-all font-mono">{r.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="border-t border-border pt-4 text-[12px] text-faint">추가 설정이 없어요.</p>
          )}
          <div className="border-t border-border pt-4">
            <p className="mb-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">버전</p>
            <div className="flex flex-wrap gap-1.5">
              {versions.map((v) => (
                <code
                  key={v}
                  className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground"
                >
                  {v}
                </code>
              ))}
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
