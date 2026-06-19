import Link from 'next/link'

import { type RuntimeSpec, runtimeSpecSchema } from '@/entities/runtime'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Card, CardContent } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm">{value}</dd>
    </div>
  )
}

export default async function RuntimeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await authContext()

  let runtime: RuntimeSpec | undefined
  let error: string | undefined
  try {
    runtime = runtimeSpecSchema.parse(await controlPlane.getRuntime(ctx, id, 'latest'))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!runtime) {
    return (
      <div className="space-y-6">
        <PageHeader title="런타임" />
        <Card className="border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          런타임을 불러올 수 없습니다: {error}
        </Card>
        <Link href="/dashboard/runtimes" className="text-sm text-primary hover:opacity-80">
          ← 런타임으로
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link href="/dashboard/runtimes" className="text-sm text-muted-foreground hover:text-foreground">
          ← 런타임
        </Link>
        <PageHeader
          title={runtime.id}
          description={runtime.description ?? '실행 인프라'}
          actions={
            <div className="flex gap-2">
              <Badge tone="info">{runtime.kind}</Badge>
              <Badge tone="neutral">v{runtime.version} (latest)</Badge>
            </div>
          }
        />
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-5 sm:grid-cols-3">
          {runtime.image && <Meta label="image" value={runtime.image} />}
          {runtime.addr && <Meta label="addr" value={runtime.addr} />}
          {runtime.context && <Meta label="context" value={runtime.context} />}
          {runtime.namespace && <Meta label="namespace" value={runtime.namespace} />}
          {runtime.runtime && <Meta label="runtime" value={runtime.runtime} />}
          {runtime.runtimeClass && <Meta label="runtimeClass" value={runtime.runtimeClass} />}
          {runtime.datacenters && runtime.datacenters.length > 0 && (
            <Meta label="datacenters" value={runtime.datacenters.join(', ')} />
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        자격증명(토큰/kubeconfig)은 이 정의에 포함되지 않습니다 — 워크스페이스 시크릿으로 관리되고 실행 시 주입됩니다.
      </p>
    </div>
  )
}
