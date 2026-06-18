import Link from 'next/link'

import { RegisterHarnessForm } from '@/features/register-harness'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default function NewHarnessPage() {
  return (
    <div className="space-y-6">
      <Link href="/dashboard/harnesses" className="text-sm text-muted-foreground hover:text-foreground">
        ← 하니스
      </Link>
      <PageHeader title="하니스 등록" description="HarnessSpec 을 이 테넌트 소유로 등록합니다." />
      <Card className="p-6">
        <RegisterHarnessForm />
      </Card>
    </div>
  )
}
