import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CreateWorkspaceForm } from '@/features/create-workspace'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace creation is self-serve for anyone (no role gate) — the creator becomes that workspace's admin.
// A new slug is minted, so it's a top-level route outside [workspace]. On creation, enter that workspace (/{id}).
export default async function NewWorkspacePage() {
  const t = await getTranslations('newWorkspacePage')
  const { principal } = await currentPrincipal()
  // Unauthenticated / auth-exchange failure → go straight to login, not the landing (/). Sending to `/` makes the middleware·page bounce into a loop.
  if (!principal) redirect('/api/auth/signin')
  // If there are no workspaces at all, onboarding is the right place, not "create another".
  if ((principal.workspaces?.length ?? 0) === 0) redirect('/onboarding')
  const back = `/${principal.workspace}`

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 px-6 py-16">
      <Link
        href={back}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('back')}
      </Link>
      <PageHeader title={t('title')} description={t('description')} />
      <Card className="p-4">
        <CreateWorkspaceForm />
      </Card>
    </main>
  )
}
