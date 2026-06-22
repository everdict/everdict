import Link from 'next/link'
import { Cpu, Plus } from 'lucide-react'

import { modelsSchema } from '@/entities/model'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function ModelsPage() {
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let models = modelsSchema.parse([])
  try {
    models = modelsSchema.parse(await controlPlane.listModels(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="모델"
        description={`${models.length}건 · 추론/판정 모델. judge·harness 가 id 로 참조해 provider/baseUrl 을 해석합니다.`}
        actions={
          can(principal?.roles, 'models:write') ? (
            <Link href="/dashboard/models/new">
              <Button size="sm">
                <Plus className="size-4" />
                모델 등록
              </Button>
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : models.length === 0 ? (
        <EmptyState
          icon={<Cpu />}
          title="등록된 모델이 없습니다."
          hint="member 이상이면 '모델 등록'으로 provider+모델을 올리거나, API(POST /models)로 등록하세요."
        />
      ) : (
        <div className="space-y-2">
          {models.map((m) => (
            <Link
              key={m.id}
              href={`/dashboard/models/${encodeURIComponent(m.id)}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border">
                  <Cpu className="size-[18px]" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 space-y-1">
                  <div className="truncate text-[13px] font-[560] text-foreground">{m.id}</div>
                  <div className="flex flex-wrap gap-1">
                    {m.versions.map((v) => (
                      <code
                        key={v}
                        className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border"
                      >
                        {v}
                      </code>
                    ))}
                  </div>
                </div>
              </div>
              <Badge tone={m.owner === principal?.workspace ? 'success' : 'neutral'}>
                {m.owner === principal?.workspace ? 'owned' : 'shared'}
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
