import Link from 'next/link'
import { ChevronLeft, KeyRound } from 'lucide-react'

import { runtimeSpecSchema, type RuntimeSpec } from '@/entities/runtime'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-[510] uppercase tracking-wide text-faint">{label}</dt>
      <dd className="mt-1 truncate font-mono text-[13px] text-foreground">{value}</dd>
    </div>
  )
}

function BackLink({ workspace }: { workspace: string }) {
  return (
    <Link
      href={`/${workspace}/runtimes`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      런타임
    </Link>
  )
}

export default async function RuntimeDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
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
      <div className="space-y-5">
        <BackLink workspace={workspace} />
        <PageHeader title="런타임" />
        <Callout tone="danger">런타임을 불러올 수 없습니다: {error}</Callout>
      </div>
    )
  }

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} />
        <PageHeader
          title={runtime.id}
          description={runtime.description ?? '실행 인프라'}
          actions={
            <div className="flex gap-2">
              <Badge tone="info">{runtime.kind}</Badge>
              <Badge tone="neutral">v{runtime.version} · latest</Badge>
            </div>
          }
        />
      </div>

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        {runtime.image && <Prop label="image" value={runtime.image} />}
        {runtime.addr && <Prop label="addr" value={runtime.addr} />}
        {runtime.context && <Prop label="context" value={runtime.context} />}
        {runtime.namespace && <Prop label="namespace" value={runtime.namespace} />}
        {runtime.runtime && <Prop label="runtime" value={runtime.runtime} />}
        {runtime.runtimeClass && <Prop label="runtimeClass" value={runtime.runtimeClass} />}
        {runtime.datacenters && runtime.datacenters.length > 0 && (
          <Prop label="datacenters" value={runtime.datacenters.join(', ')} />
        )}
      </Card>

      <section className="space-y-2.5">
        <SectionHeader title="자격증명" />
        <Callout tone="muted">
          <span className="inline-flex items-center gap-1.5 font-[510] text-foreground">
            <KeyRound className="size-3.5" />
            토큰 · kubeconfig 는 이 정의에 포함되지 않습니다
          </span>
          <p className="mt-1 text-[12px] text-muted-foreground">
            워크스페이스 시크릿으로 관리되고 실행 시 주입됩니다.
          </p>
        </Callout>
      </section>
    </div>
  )
}
