import Link from 'next/link'

import { type Harness, harnessesSchema } from '@/entities/harness'
import { SubmitRunForm } from '@/features/submit-run'
import { currentTenant } from '@/shared/auth/tenant'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewRunPage() {
  const { tenant } = await currentTenant()
  let harnesses: Harness[] = []
  try {
    harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(tenant))
  } catch {
    // 하니스 목록 실패해도 폼은 텍스트 입력으로 동작
  }

  return (
    <div className="space-y-6">
      <Link href="/dashboard/runs" className="text-sm text-muted-foreground hover:text-foreground">
        ← Runs
      </Link>
      <PageHeader title="새 run" description="하니스를 골라 평가를 제출합니다." />
      <Card className="p-6">
        <SubmitRunForm harnesses={harnesses} />
      </Card>
    </div>
  )
}
