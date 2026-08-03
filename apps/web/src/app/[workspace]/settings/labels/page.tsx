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

// Workspace › Labels — 이슈를 분류하는 워크스페이스 어휘(docs/tracker.md).
// 트래커의 액션 쌍을 그대로 쓴다: 읽기 issues:read(viewer+) / 정의·수정·삭제 issues:write(member+).
// 라벨은 별도의 권한 표면이 아니라 이슈를 분류하는 일의 일부다.
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
