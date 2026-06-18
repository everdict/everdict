import Link from 'next/link'

import { type ScorecardRecord, scorecardRecordSchema } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Card, CardContent } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'
import { StatCard } from '@/shared/ui/stat-card'
import { StatusPill } from '@/shared/ui/status-pill'

export const dynamic = 'force-dynamic'

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm">{value}</dd>
    </div>
  )
}

export default async function ScorecardDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await authContext()

  let record: ScorecardRecord | undefined
  let error: string | undefined
  try {
    record = scorecardRecordSchema.parse(await controlPlane.getScorecard(ctx, id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!record) {
    return (
      <div className="space-y-6">
        <PageHeader title="스코어카드" />
        <Card className="border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          스코어카드를 불러올 수 없습니다: {error}
        </Card>
        <Link href="/dashboard/scorecards" className="text-sm text-primary hover:opacity-80">
          ← 스코어카드로
        </Link>
      </div>
    )
  }

  const summary = record.summary ?? []
  const results = record.scorecard?.results ?? []

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link href="/dashboard/scorecards" className="text-sm text-muted-foreground hover:text-foreground">
          ← 스코어카드
        </Link>
        <PageHeader
          title={`scorecard ${record.id.slice(0, 8)}`}
          description={`${record.dataset.id}@${record.dataset.version} → ${record.harness.id}@${record.harness.version}`}
          actions={<StatusPill status={record.status} />}
        />
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-5 sm:grid-cols-4">
          <Meta label="dataset" value={`${record.dataset.id}@${record.dataset.version}`} />
          <Meta label="harness" value={`${record.harness.id}@${record.harness.version}`} />
          <Meta label="created" value={new Date(record.createdAt).toLocaleString()} />
          <Meta label="updated" value={new Date(record.updatedAt).toLocaleString()} />
        </CardContent>
      </Card>

      {record.error && (
        <Card className="border-destructive/30 bg-destructive/5 p-5">
          <div className="text-sm font-semibold text-destructive">{record.error.code}</div>
          <div className="mt-1 text-sm text-muted-foreground">{record.error.message}</div>
        </Card>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">집계 (메트릭별)</h2>
        {summary.length === 0 ? (
          <p className="text-sm text-muted-foreground">집계가 없습니다.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {summary.map((m) => (
              <StatCard
                key={m.metric}
                label={m.metric}
                value={m.mean.toFixed(2)}
                hint={`n=${m.count}${m.passRate != null ? ` · pass ${Math.round(m.passRate * 100)}%` : ''}`}
                tone={m.passRate != null ? (m.passRate >= 1 ? 'success' : m.passRate > 0 ? 'primary' : 'danger') : 'default'}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">케이스별 ({results.length})</h2>
        {results.length === 0 ? (
          <p className="text-sm text-muted-foreground">케이스 결과가 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {results.map((r) => (
              <Card key={r.caseId}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
                  <span className="font-mono text-sm font-medium">{r.caseId}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {r.scores.length === 0 ? (
                      <span className="text-xs text-muted-foreground">점수 없음</span>
                    ) : (
                      r.scores.map((s) => (
                        <Badge key={s.graderId} tone={s.pass == null ? 'neutral' : s.pass ? 'success' : 'danger'}>
                          {s.metric} {s.value}
                        </Badge>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
