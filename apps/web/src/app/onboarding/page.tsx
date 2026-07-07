import { redirect } from 'next/navigation'
import { FlaskConical } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CreateWorkspaceForm } from '@/features/create-workspace'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'

export const dynamic = 'force-dynamic'

// First-login onboarding — a user with 0 workspaces creates their first workspace (Linear-style). Since there's no slug yet,
// keep it as a top-level route rather than under [workspace]. On creation, enter that workspace (/{id}).
export default async function OnboardingPage() {
  const t = await getTranslations('onboardingPage')
  const { principal } = await currentPrincipal()
  // Unauthenticated / auth-exchange failure → go straight to login, not the landing (/). Sending to `/` makes the middleware·page bounce into a loop.
  if (!principal) redirect('/api/auth/signin')
  // If a workspace already exists, onboarding isn't needed → go to the default workspace.
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
