import { redirect } from 'next/navigation'
import { FlaskConical } from 'lucide-react'

import { CreateWorkspaceForm } from '@/features/create-workspace'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'

export const dynamic = 'force-dynamic'

// 첫 로그인 온보딩 — 워크스페이스가 0개인 사용자가 첫 워크스페이스를 만든다(Linear 식). 슬러그가 아직 없어
// [workspace] 밑이 아니라 최상위 라우트로 둔다. 만들면 그 워크스페이스(/{id})로 들어간다.
export default async function OnboardingPage() {
  const { principal } = await currentPrincipal()
  if (!principal) redirect('/')
  // 이미 워크스페이스가 있으면 온보딩이 필요 없다 → 기본 워크스페이스로.
  if ((principal.workspaces?.length ?? 0) > 0) redirect(`/${principal.workspace}`)

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.12)_inset,0_6px_18px_-6px_var(--primary)]">
          <FlaskConical className="size-[18px]" />
        </span>
        <span className="font-display text-[16px] font-[560] tracking-tight">Assay</span>
      </div>
      <div className="space-y-2">
        <h1 className="font-display text-[22px] font-[560] tracking-[-0.02em]">
          워크스페이스를 만들어 시작하세요
        </h1>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          환영합니다. 평가를 담을 워크스페이스가 아직 없습니다. 하나 만들면 바로 그 워크스페이스로
          들어갑니다.
        </p>
      </div>
      <Card className="p-5">
        <CreateWorkspaceForm />
      </Card>
    </main>
  )
}
