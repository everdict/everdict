import { harnessesSchema, type Harness } from '@/entities/harness'
import { runsSchema, type Run } from '@/entities/run'
import { RunsTable } from '@/widgets/runs-table'
import { ScorecardSummary } from '@/widgets/scorecard-summary'
import { auth } from '@/shared/auth/auth'
import { keycloakConfigured } from '@/shared/config/env'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Card, CardContent, CardDescription, CardTitle } from '@/shared/ui/card'

// 컨트롤플레인을 매 요청 조회 → 프리렌더 금지.
export const dynamic = 'force-dynamic'

async function load(tenant: string): Promise<{ runs: Run[]; harnesses: Harness[]; error?: string }> {
  try {
    const [runs, harnesses] = await Promise.all([
      controlPlane.listRuns(tenant).then((d) => runsSchema.parse(d)),
      controlPlane.listHarnesses(tenant).then((d) => harnessesSchema.parse(d)),
    ])
    return { runs, harnesses }
  } catch (e) {
    return { runs: [], harnesses: [], error: e instanceof Error ? e.message : String(e) }
  }
}

export default async function DashboardPage() {
  // Keycloak 설정 시에만 세션 확인(미설정 dev 에선 AUTH_SECRET 불필요). tenant 기본 = default.
  const session = keycloakConfigured ? await auth() : null
  const tenant = session?.tenant ?? 'default'
  const { runs, harnesses, error } = await load(tenant)

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">대시보드</h1>
          <p className="text-sm text-muted-foreground">
            tenant <span className="font-mono">{tenant}</span>
          </p>
        </div>
        <Badge tone="info">{session ? 'authenticated' : 'dev'}</Badge>
      </header>

      {error ? (
        <Card className="border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          컨트롤플레인에 연결할 수 없습니다: {error}
          <div className="mt-1 text-muted-foreground">
            `CONTROL_PLANE_URL` 과 `assay-api` 가동 여부를 확인하세요.
          </div>
        </Card>
      ) : (
        <ScorecardSummary runs={runs} />
      )}

      <section className="space-y-3">
        <CardTitle className="text-lg">최근 runs</CardTitle>
        <RunsTable runs={runs} />
      </section>

      <section className="space-y-3">
        <div>
          <CardTitle className="text-lg">하니스</CardTitle>
          <CardDescription>이 테넌트가 등록한 하니스 + 공유(first-party)</CardDescription>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {harnesses.map((h) => (
            <Card key={h.id}>
              <CardContent className="space-y-2 pt-5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{h.id}</span>
                  <Badge tone={h.owner === tenant ? 'success' : 'neutral'}>
                    {h.owner === tenant ? 'owned' : 'shared'}
                  </Badge>
                </div>
                <div className="font-mono text-xs text-muted-foreground">{h.versions.join(', ')}</div>
              </CardContent>
            </Card>
          ))}
          {harnesses.length === 0 && (
            <Card className="p-5 text-sm text-muted-foreground">등록된 하니스가 없습니다.</Card>
          )}
        </div>
      </section>
    </main>
  )
}
