import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { RegisterRubricForm } from '@/features/register-rubric'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Rubric registration — reuses the judges:write gate (a rubric is judging vocabulary, not a new permission surface).
export default async function NewRubricPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const t = await getTranslations('rubricsPage')
  const { principal } = await currentPrincipal()
  const allowed = can(principal?.roles, 'judges:write')

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/${workspace}/rubrics`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {t('title')}
        </Link>
        <PageHeader title={t('register')} description={t('registerDescription')} />
      </div>
      {allowed ? (
        <Card className="p-5">
          <RegisterRubricForm workspace={workspace} />
        </Card>
      ) : (
        <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
      )}
    </div>
  )
}
