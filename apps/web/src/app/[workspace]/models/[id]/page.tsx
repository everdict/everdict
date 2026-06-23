import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { modelSpecSchema, type ModelSpec } from '@/entities/model'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

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
      href={`/${workspace}/models`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      모델
    </Link>
  )
}

export default async function ModelDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const ctx = await authContext()

  let model: ModelSpec | undefined
  let error: string | undefined
  try {
    model = modelSpecSchema.parse(await controlPlane.getModel(ctx, id, 'latest'))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!model) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} />
        <PageHeader title="모델" />
        <Callout tone="danger">모델을 불러올 수 없습니다: {error}</Callout>
      </div>
    )
  }

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} />
        <PageHeader
          title={model.id}
          description={model.description ?? '추론/판정 모델'}
          actions={<Badge tone="info">{`${model.id}@${model.version}`}</Badge>}
        />
      </div>

      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Prop label="provider" value={model.provider} />
        <Prop label="model" value={model.model} />
        <Prop label="version" value={model.version} />
        {model.baseUrl ? <Prop label="baseUrl" value={model.baseUrl} /> : null}
        {model.params?.temperature !== undefined ? (
          <Prop label="temperature" value={String(model.params.temperature)} />
        ) : null}
        {model.params?.maxTokens !== undefined ? (
          <Prop label="maxTokens" value={String(model.params.maxTokens)} />
        ) : null}
      </Card>

      {model.tags && model.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {model.tags.map((t) => (
            <Badge key={t} tone="neutral">
              {t}
            </Badge>
          ))}
        </div>
      ) : null}

      <p className="text-[12px] leading-relaxed text-muted-foreground">
        API 키는 여기 없습니다 — provider 별 시크릿(설정 → 시크릿)을 사용합니다. judge 의 model 을
        이 id 로 두면 이 provider/baseUrl 로 해석됩니다.
      </p>
    </div>
  )
}
