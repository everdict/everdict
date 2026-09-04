import { getTranslations } from 'next-intl/server'

import { checkpointListSchema, type Checkpoint } from '@/entities/checkpoint'
import { VerifyCheckpointButton } from '@/features/browse-checkpoints'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// ── WHAT AN AGENT LEFT BEHIND ──────────────────────────────────────────────────────────────────────
//
// A handoff checkpoint is the state transfer between agents: confirmed facts with their evidence, open
// decisions, what remains. It is evidence about how a task STOPPED — and until this page it could be
// written by an agent, verified by an agent, and read by nobody else.
// docs/architecture/web-runtime-gap-census-spec.md
export default async function CheckpointsPage() {
  const t = await getTranslations('checkpointsPage')
  const ctx = await authContext()

  let checkpoints: Checkpoint[] = []
  let error: string | undefined
  try {
    checkpoints = checkpointListSchema.parse(await controlPlane.listCheckpoints(ctx))
  } catch (e) {
    // A read that failed is not "no handoffs". Telling a reader nothing was left behind is the one wrong
    // answer a page about what an agent left behind can give.
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t('title')} description={t('description')} />
      {error !== undefined && <Callout tone="danger">{t('loadError', { error })}</Callout>}
      {error === undefined && checkpoints.length === 0 && <EmptyState title={t('empty')} />}
      {checkpoints.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {checkpoints.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              {/* NOT VERIFIED is different from VERIFIED-AND-INCONCLUSIVE: the first means nobody asked.
                  A single grey badge for both would hide which one this is. */}
              <Badge tone={c.verification === undefined ? 'neutral' : 'success'}>
                {c.verification === undefined ? t('unverified') : c.verification.status}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-[13px]" title={c.goal}>
                {c.goal}
              </span>
              {c.role !== undefined && (
                <span className="shrink-0 font-mono text-[11px] text-faint">{c.role}</span>
              )}
              <span className="shrink-0 text-[12px] text-muted-foreground">{c.createdBy}</span>
              <span className="shrink-0 text-[11px] text-faint">{c.createdAt}</span>
              <VerifyCheckpointButton id={c.id} verified={c.verification !== undefined} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
