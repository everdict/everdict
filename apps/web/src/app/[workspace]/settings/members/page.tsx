import { getTranslations } from 'next-intl/server'

import { invitesSchema, membersSchema, type Invite, type Member } from '@/entities/member'
import { InvitesManager } from '@/features/manage-invites'
import { MembersManager } from '@/features/manage-members'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace › Members — team roster + invitations (members:read; role change/invite/remove = members:write = admin).
export default async function MembersPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'members:read')
  const canWrite = can(principal?.roles, 'members:write')
  const header = <PageHeader title={t('members')} description={t('membersDesc')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let members: Member[] = []
  let invites: Invite[] = []
  let error: string | undefined
  try {
    members = membersSchema.parse(await controlPlane.listMembers(ctx))
    if (canWrite) invites = invitesSchema.parse(await controlPlane.listInvites(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <div className="space-y-8">
          <MembersManager members={members} canWrite={canWrite} />
          {canWrite && <InvitesManager invites={invites} canWrite />}
        </div>
      )}
    </div>
  )
}
