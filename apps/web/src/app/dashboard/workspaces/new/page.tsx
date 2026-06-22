import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { CreateWorkspaceForm } from '@/features/create-workspace'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 워크스페이스 생성은 누구나 가능한 self-serve(워크스페이스 내부 역할 게이트 없음) — 생성자는 그 워크스페이스의 admin.
export default function NewWorkspacePage() {
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        대시보드
      </Link>
      <PageHeader
        title="새 워크스페이스"
        description="평가를 격리해 담을 새 워크스페이스를 만듭니다. 만든 사람은 admin 이 됩니다."
      />
      <Card className="p-4">
        <CreateWorkspaceForm />
      </Card>
    </div>
  )
}
