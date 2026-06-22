import Link from 'next/link'

import { modelSpecSchema, type ModelSpec } from '@/entities/model'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
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

export default async function ModelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
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
      <div className="space-y-6">
        <PageHeader title="모델" />
        <Callout tone="danger">모델을 불러올 수 없습니다: {error}</Callout>
        <Link
          href="/dashboard/models"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← 모델
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard/models"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← 모델
      </Link>
      <PageHeader
        title={model.id}
        description={model.description ?? '추론/판정 모델'}
        actions={<Badge tone="info">{`${model.id}@${model.version}`}</Badge>}
      />
      <Card>
        <CardContent className="pt-5">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            <Meta label="provider" value={model.provider} />
            <Meta label="model" value={model.model} />
            <Meta label="version" value={model.version} />
            {model.baseUrl ? <Meta label="baseUrl" value={model.baseUrl} /> : null}
            {model.params?.temperature !== undefined ? (
              <Meta label="temperature" value={String(model.params.temperature)} />
            ) : null}
            {model.params?.maxTokens !== undefined ? (
              <Meta label="maxTokens" value={String(model.params.maxTokens)} />
            ) : null}
          </dl>
          {model.tags && model.tags.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-1">
              {model.tags.map((t) => (
                <Badge key={t} tone="neutral">
                  {t}
                </Badge>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        API 키는 여기 없습니다 — provider 별 시크릿(설정 → 시크릿)을 사용합니다. judge 의 model 을
        이 id 로 두면 이 provider/baseUrl 로 해석됩니다.
      </p>
    </div>
  )
}
