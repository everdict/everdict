import { getTranslations } from 'next-intl/server'

import { MemberList, type MemberRow } from '@/widgets/member-list'
import { membersSchema, type Member } from '@/entities/member'
import { can } from '@/shared/auth/can'
import { authContext, currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Members — the app-level PEOPLE DIRECTORY (members:read = viewer+). It answers "who is here and which teams
// are they on"; Settings › Members answers "invite, change a role, remove" (members:write = admin). The split
// is the same one Teams has: looking someone up should not hand the sidebar over to configuration.
export default async function MembersDirectoryPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const t = await getTranslations('membersDirectory')
  const { principal } = await currentPrincipal()
  const ctx = await authContext()

  let members: Member[] = []
  let error: string | undefined
  try {
    members = membersSchema.parse(await controlPlane.listMembers(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // 행 모델은 서버에서 완성한다 — 위젯은 검색·필터·정렬만 하고 데이터를 다시 모으지 않는다.
  const rows: MemberRow[] = members.map((member) => ({
    subject: member.subject,
    role: member.role,
    addedAt: member.addedAt,
    ...(member.name ? { name: member.name } : {}),
    ...(member.email ? { email: member.email } : {}),
    ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
  }))

  const canManage = can(principal?.roles, 'members:write')

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        {...(canManage
          ? {
              actions: (
                <Link
                  href={`/${workspace}/settings/members`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {t('manage')}
                </Link>
              ),
            }
          : {})}
      />

      {error && <Callout tone="danger">{error}</Callout>}

      <MemberList
        workspace={workspace}
        members={rows}
        {...(principal ? { currentSubject: principal.subject } : {})}
      />
    </div>
  )
}
