import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'

import { CreateWorkspaceForm } from '@/features/create-workspace'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 워크스페이스 생성은 누구나 가능한 self-serve(역할 게이트 없음) — 생성자는 그 워크스페이스의 admin.
// 슬러그가 새로 생기므로 [workspace] 밖 최상위 라우트. 만들면 그 워크스페이스(/{id})로 들어간다.
export default async function NewWorkspacePage() {
  const { principal } = await currentPrincipal()
  if (!principal) redirect('/')
  // 워크스페이스가 하나도 없으면 "또 만들기"가 아니라 온보딩이 맞다.
  if ((principal.workspaces?.length ?? 0) === 0) redirect('/onboarding')
  const back = `/${principal.workspace}`

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 px-6 py-16">
      <Link
        href={back}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        돌아가기
      </Link>
      <PageHeader
        title="새 워크스페이스"
        description="평가를 격리해 담을 새 워크스페이스를 만듭니다. 만든 사람은 admin 이 됩니다."
      />
      <Card className="p-4">
        <CreateWorkspaceForm />
      </Card>
    </main>
  )
}
