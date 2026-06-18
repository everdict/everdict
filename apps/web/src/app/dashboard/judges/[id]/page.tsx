import Link from 'next/link'

import { type JudgeSpec, judgeSpecSchema } from '@/entities/judge'
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

export default async function JudgeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await authContext()

  let judge: JudgeSpec | undefined
  let error: string | undefined
  try {
    judge = judgeSpecSchema.parse(await controlPlane.getJudge(ctx, id, 'latest'))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!judge) {
    return (
      <div className="space-y-6">
        <PageHeader title="Judge" />
        <Card className="border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          Judge 를 불러올 수 없습니다: {error}
        </Card>
        <Link href="/dashboard/judges" className="text-sm text-primary hover:opacity-80">
          ← Judge 로
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link href="/dashboard/judges" className="text-sm text-muted-foreground hover:text-foreground">
          ← Judge
        </Link>
        <PageHeader
          title={judge.id}
          description={judge.description ?? 'Agent Judge'}
          actions={
            <div className="flex gap-2">
              <Badge tone="info">{judge.kind}</Badge>
              <Badge tone="neutral">v{judge.version} (latest)</Badge>
            </div>
          }
        />
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-5 sm:grid-cols-3">
          {judge.kind === 'model' ? (
            <>
              <Meta label="provider" value={judge.provider ?? '—'} />
              <Meta label="model" value={judge.model ?? '—'} />
              <Meta label="inputs" value={(judge.inputs ?? []).join(', ') || '—'} />
              {judge.passThreshold != null && <Meta label="pass 임계값" value={String(judge.passThreshold)} />}
            </>
          ) : (
            <Meta
              label="harness"
              value={judge.harness ? `${judge.harness.id}@${judge.harness.version}` : '—'}
            />
          )}
        </CardContent>
      </Card>

      {judge.rubric && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Rubric</h2>
          <Card className="p-5">
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{judge.rubric}</p>
          </Card>
        </section>
      )}
    </div>
  )
}
