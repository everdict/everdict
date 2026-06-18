import { harnessesSchema } from '@/entities/harness'
import { currentTenant } from '@/shared/auth/tenant'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Card, CardContent } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function HarnessesPage() {
  const { tenant } = await currentTenant()
  let error: string | undefined
  let harnesses = harnessesSchema.parse([])
  try {
    harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(tenant))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader title="하니스" description="이 테넌트가 등록한 하니스 + 공유(first-party)" />
      {error ? (
        <Card className="border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          컨트롤플레인 연결 실패: {error}
        </Card>
      ) : harnesses.length === 0 ? (
        <EmptyState
          title="등록된 하니스가 없습니다."
          hint="API 키로 POST /harnesses 하거나, 파일 SSOT(examples/harnesses)를 _shared 로 로드하세요."
        />
      ) : (
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
                <div className="flex flex-wrap gap-1">
                  {h.versions.map((v) => (
                    <code key={v} className="rounded-md bg-secondary px-1.5 py-0.5 text-xs">
                      {v}
                    </code>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
