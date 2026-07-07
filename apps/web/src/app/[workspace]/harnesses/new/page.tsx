import Link from 'next/link'
import { ChevronLeft, Lock } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { RegisterHarnessWizard } from '@/features/register-harness'
import { secretsSchema } from '@/entities/secret'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewHarnessPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('harnessesPage')
  const allowed = can(principal?.roles, 'harnesses:register')

  // env 시크릿 참조 피커용 — 공유(workspace) + 내 개인(user) 시크릿 이름(값은 안 옴). 실패/무권한이면 빈 목록.
  let secrets = { workspace: [] as string[], user: [] as string[] }
  if (allowed) {
    try {
      const metas = secretsSchema.parse(await controlPlane.listSecrets(ctx))
      secrets = {
        workspace: metas.filter((m) => m.scope === 'workspace').map((m) => m.name),
        user: metas.filter((m) => m.scope === 'user').map((m) => m.name),
      }
    } catch {
      secrets = { workspace: [], user: [] }
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/harnesses`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('backToList')}
      </Link>
      <PageHeader title={t('registerTitle')} description={t('registerDescription')} />
      {allowed ? (
        <Card className="p-5">
          <RegisterHarnessWizard secrets={secrets} />
        </Card>
      ) : (
        <EmptyState icon={<Lock />} title={t('noPermTitle')} hint={t('noPermHint')} />
      )}
    </div>
  )
}
