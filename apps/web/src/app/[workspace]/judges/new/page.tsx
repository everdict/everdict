import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { RegisterJudgeForm } from '@/features/register-judge'
import { rubricsSchema } from '@/entities/rubric'
import { runtimesSchema } from '@/entities/runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewJudgePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('judgesPage')
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'judges:write')

  // For the harness judge's runtime selector — the form renders even on failure (empty = co-locate/default only).
  let runtimes: { id: string }[] = []
  try {
    runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
  } catch {
    runtimes = []
  }

  // For the registered-rubric selector — the form renders even on failure (empty = inline mode still works).
  let rubrics: { id: string; owner: string }[] = []
  try {
    rubrics = rubricsSchema.parse(await controlPlane.listRubrics(ctx))
  } catch {
    rubrics = []
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/${workspace}/judges`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {t('title')}
        </Link>
        <PageHeader title={t('register')} description={t('registerDescription')} />
      </div>
      {allowed ? (
        <Card className="p-5">
          <RegisterJudgeForm workspace={workspace} runtimes={runtimes} rubrics={rubrics} />
        </Card>
      ) : (
        <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
      )}
    </div>
  )
}
