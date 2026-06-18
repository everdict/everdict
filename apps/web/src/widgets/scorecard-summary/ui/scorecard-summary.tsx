import { type Run } from '@/entities/run'
import { Card, CardContent, CardDescription, CardTitle } from '@/shared/ui/card'

// 테넌트 스코어 요약: 총 run, 성공률, 평균 점수(steps 등). per-tenant 대시보드의 핵심 카드.
function summarize(runs: Run[]) {
  const total = runs.length
  const succeeded = runs.filter((r) => r.status === 'succeeded').length
  const failed = runs.filter((r) => r.status === 'failed').length
  const passRate = total ? Math.round((succeeded / total) * 100) : 0
  return { total, succeeded, failed, passRate }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="font-mono text-3xl font-semibold tabular-nums">{value}</div>
        <div className="mt-1 text-sm text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  )
}

export function ScorecardSummary({ runs }: { runs: Run[] }) {
  const s = summarize(runs)
  return (
    <section className="space-y-3">
      <div>
        <CardTitle className="text-lg">스코어카드</CardTitle>
        <CardDescription>이 테넌트의 평가 결과 요약</CardDescription>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="전체 run" value={String(s.total)} />
        <Stat label="성공" value={String(s.succeeded)} />
        <Stat label="실패" value={String(s.failed)} />
        <Stat label="성공률" value={`${s.passRate}%`} />
      </div>
    </section>
  )
}
