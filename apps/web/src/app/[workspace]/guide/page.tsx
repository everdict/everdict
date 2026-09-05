import { getTranslations } from 'next-intl/server'

import { StartTourButton, UsageGuide } from '@/features/get-started'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// The usage guide for a new user — everdict's eval flow at a glance, with an entry into each step. Workspace-scoped (the [workspace] layout verifies membership).
export default async function GuidePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('guidePage')
  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} actions={<StartTourButton />} />
      <UsageGuide workspace={workspace} />
    </div>
  )
}
