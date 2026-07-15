import Link from 'next/link'
import { ChevronLeft, Lock } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { RegisterHarnessWizard } from '@/features/register-harness'
import { modelsSchema } from '@/entities/model'
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

  // For the env secret reference picker — shared (workspace) + my personal (user) secret names (no values). Empty list on failure/no permission.
  let secrets = { workspace: [] as string[], user: [] as string[] }
  // Registered Model ids — offered in the command/service model binding picker (best-effort; empty on failure/no models).
  let modelIds: string[] = []
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
    try {
      modelIds = modelsSchema.parse(await controlPlane.listModels(ctx)).map((m) => m.id)
    } catch {
      modelIds = []
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
          <RegisterHarnessWizard secrets={secrets} modelIds={modelIds} />
        </Card>
      ) : (
        <EmptyState icon={<Lock />} title={t('noPermTitle')} hint={t('noPermHint')} />
      )}
    </div>
  )
}
