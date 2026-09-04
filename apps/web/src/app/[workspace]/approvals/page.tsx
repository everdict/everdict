import { getTranslations } from 'next-intl/server'

import { approvalListSchema } from '@/entities/approval'
import { ApprovalDecision } from '@/features/decide-approval'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// ── THE HUMAN'S HALF OF A HUMAN-IN-THE-LOOP QUEUE ──────────────────────────────────────────────────
//
// A parked agent mutation waits for a MEMBER to approve or deny it. Until this page the decision was
// reachable only from the agent surface, so the person the queue exists for had no door: a census of the
// control plane against the web found `/approvals` and `/approvals/:id/decide` unreachable, and named it
// the sharpest case it had. docs/architecture/web-runtime-gap-census-spec.md
export default async function ApprovalsPage() {
  const t = await getTranslations('approvalsPage')
  const ctx = await authContext()

  let approvals: ReturnType<typeof approvalListSchema.parse> = []
  let error: string | undefined
  try {
    approvals = approvalListSchema.parse(await controlPlane.listApprovals(ctx))
  } catch (e) {
    // A read that failed is NOT an empty queue: showing "nothing to approve" over an unreadable store would
    // tell a member that an agent is not waiting when it is.
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t('title')} description={t('description')} />
      {error !== undefined && <Callout tone="danger">{t('loadError', { error })}</Callout>}
      {error === undefined && approvals.length === 0 && <EmptyState title={t('empty')} />}
      {approvals.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {approvals.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
              <Badge tone={a.status === 'pending' ? 'warning' : a.status === 'approved' ? 'success' : 'neutral'}>
                {t(`status.${a.status}`)}
              </Badge>
              <span className="shrink-0 font-mono text-[12.5px] font-[510]">{a.request.name}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                {t('askedBy', { agent: a.agentId ?? a.sessionId })}
              </span>
              {/* Not deciding is itself a decision — an expired approval is denied — so the deadline is on
                  the row rather than behind a hover. */}
              <span className="shrink-0 text-[12px] text-faint">{t('expires', { at: a.expiresAt })}</span>
              <ApprovalDecision id={a.id} pending={a.status === 'pending'} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
