import { getTranslations } from 'next-intl/server'

import { issueLabelsSchema, type IssueLabel } from '@/entities/issue-label'
import { IssueLabelsManager } from '@/features/manage-issue-labels'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace › Labels — the workspace vocabulary that classifies issues (docs/tracker.md).
// It uses the tracker's action pair verbatim: reading is issues:read (viewer+), defining/editing/deleting is issues:write (member+).
// A label is not a separate permission surface but part of the work of classifying issues.
export default async function LabelsPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'issues:read')
  const canWrite = can(principal?.roles, 'issues:write')
  const header = <PageHeader title={t('labels')} description={t('labelsDesc')} />
  if (!canRead || !principal) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let labels: IssueLabel[] = []
  let error: string | undefined
  try {
    labels = issueLabelsSchema.parse(await controlPlane.listIssueLabels(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <IssueLabelsManager labels={labels} canWrite={canWrite} />
      )}
    </div>
  )
}
