import { getTranslations } from 'next-intl/server'

import { ActivityConsole } from '@/features/browse-activity'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function RunsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('runsPage')

  // The activity console (every execution in this workspace) fetches + paginates its feed client-side: scorecard
  // batches load as lightweight summary rows (cases expand on demand), so opening this page no longer blocks on
  // pulling every case run at once. The old server-side scope=all fetch is gone.
  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ActivityConsole workspace={workspace} />
    </div>
  )
}
