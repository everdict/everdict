import { redirect } from 'next/navigation'
import { FlaskConical } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CreateWorkspaceForm } from '@/features/create-workspace'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'

export const dynamic = 'force-dynamic'

// 첫 로그인 온보딩 — 워크스페이스가 0개인 사용자가 첫 워크스페이스를 만든다(Linear 식). 슬러그가 아직 없어
// [workspace] 밑이 아니라 최상위 라우트로 둔다. 만들면 그 워크스페이스(/{id})로 들어간다.
export default async function OnboardingPage() {
  const t = await getTranslations('onboardingPage')
  const { principal } = await currentPrincipal()
  // 미인증/인증 교환 실패 → 랜딩(/)이 아니라 곧장 로그인으로. `/` 로 보내면 미들웨어·페이지가 다시 튕겨 루프.
  if (!principal) redirect('/api/auth/signin')
  // 이미 워크스페이스가 있으면 온보딩이 필요 없다 → 기본 워크스페이스로.
  if ((principal.workspaces?.length ?? 0) > 0) redirect(`/${principal.workspace}`)

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.12)_inset,0_6px_18px_-6px_var(--primary)]">
          <FlaskConical className="size-[18px]" />
        </span>
        <span className="font-display text-[16px] font-[560] tracking-tight">Everdict</span>
      </div>
      <div className="space-y-2">
        <h1 className="font-display text-[22px] font-[560] tracking-[-0.02em]">{t('title')}</h1>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t('description')}</p>
      </div>
      <Card className="p-5">
        <CreateWorkspaceForm />
      </Card>
    </main>
  )
}
