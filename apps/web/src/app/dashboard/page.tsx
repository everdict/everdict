import Link from 'next/link'

import { RunsTable } from '@/widgets/runs-table'
import { ScorecardSummary } from '@/widgets/scorecard-summary'
import { harnessesSchema } from '@/entities/harness'
import { runsSchema } from '@/entities/run'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { Card, CardContent } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

export default async function OverviewPage() {
  const ctx = await authContext()
  let error: string | undefined
  let runs = runsSchema.parse([])
  let harnesses = harnessesSchema.parse([])
  try {
    const [r, h] = await Promise.all([controlPlane.listRuns(ctx), controlPlane.listHarnesses(ctx)])
    runs = runsSchema.parse(r)
    harnesses = harnessesSchema.parse(h)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-8">
      <PageHeader title="개요" description="이 워크스페이스의 평가 현황" />

      {error ? (
        <Callout tone="danger" hint="`CONTROL_PLANE_URL` 과 `assay-api` 가동 여부를 확인하세요.">
          컨트롤플레인에 연결할 수 없습니다: {error}
        </Callout>
      ) : (
        <ScorecardSummary runs={runs} />
      )}

      <section className="space-y-3">
        <SectionHeader
          title="최근 runs"
          action={
            <Link
              href="/dashboard/runs"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              전체 보기
            </Link>
          }
        />
        <RunsTable runs={runs} limit={5} />
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="하니스"
          action={
            <Link
              href="/dashboard/harnesses"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              전체 보기
            </Link>
          }
        />
        {harnesses.length === 0 ? (
          <EmptyState
            title="등록된 하니스가 없습니다."
            hint="API(POST /harnesses) 또는 파일 SSOT 로 등록하세요."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {harnesses.slice(0, 6).map((h) => (
              <Card key={h.id}>
                <CardContent className="space-y-1.5 pt-5">
                  <div className="font-semibold">{h.id}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {h.versions.join(', ')}
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
