import Link from 'next/link'

import { modelsSchema } from '@/entities/model'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Card, CardContent } from '@/shared/ui/card'
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
        description="이 워크스페이스가 등록한 추론/판정 모델 + 공유(기본). judge·harness 가 id 로 참조해 provider/baseUrl 을 해석합니다."
        actions={
          can(principal?.roles, 'models:write') ? (
            <Link href="/dashboard/models/new" className={buttonVariants({ size: 'sm' })}>
              모델 등록
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : models.length === 0 ? (
        <EmptyState
          title="등록된 모델이 없습니다."
          hint="member 이상이면 '모델 등록'으로 provider+모델을 올리거나, API(POST /models)로 등록하세요."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {models.map((m) => (
            <Link key={m.id} href={`/dashboard/models/${encodeURIComponent(m.id)}`}>
              <Card className="transition-colors hover:border-primary/40">
                <CardContent className="space-y-2 pt-5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{m.id}</span>
                    <Badge tone={m.owner === principal?.workspace ? 'success' : 'neutral'}>
                      {m.owner === principal?.workspace ? 'owned' : 'shared'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {m.versions.map((v) => (
                      <code
                        key={v}
                        className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs"
                      >
                        {v}
                      </code>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
