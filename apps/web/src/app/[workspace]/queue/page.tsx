import { getTranslations } from 'next-intl/server'

import { QueueBoard } from '@/widgets/queue-board'
import { membersSchema } from '@/entities/member'
import { queueSnapshotSchema, type QueueSnapshot } from '@/entities/queue'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { AutoRefresh } from '@/shared/ui/auto-refresh'
import { Callout } from '@/shared/ui/callout'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Work queue — which runtime each scheduled-fire·scorecard·run workload is running/waiting on, and what's next.
export default async function QueuePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('queuePage')
  const { ctx } = await currentPrincipal()

  let snapshot: QueueSnapshot | undefined
  let error: string | undefined
  try {
    snapshot = queueSnapshotSchema.parse(await controlPlane.getQueue(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // The runner's name (members join) is supplementary — the board still shows even if it fails.
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  const live = (snapshot?.totals.running ?? 0) + (snapshot?.totals.queued ?? 0) > 0

  return (
    <div className="space-y-6">
      {/* If there are active jobs, periodically re-run to live-refresh progress/queue (no polling when all idle). */}
      <AutoRefresh enabled={live} intervalMs={5000} />
      <PageHeader title={t('title')} description={t('description')} />
      {error || !snapshot ? (
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      ) : (
        <QueueBoard snapshot={snapshot} workspace={workspace} authors={authors} />
      )}
    </div>
  )
}
