import { getTranslations } from 'next-intl/server'

import { MemberList, type MemberRow } from '@/widgets/member-list'
import { membersSchema, type Member } from '@/entities/member'
import { teamsWithSummarySchema, type TeamWithSummary } from '@/entities/team'
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

  // 각 팀의 로스터를 모아 subject → 팀 목록으로 뒤집는다. 팀 소속은 워크스페이스 멤버십과 별도 로스터라
  // 멤버 레코드에는 없다 — 그래서 여기서 합쳐야 "이 사람이 어느 팀인가"에 답할 수 있다.
  const teams: TeamWithSummary[] = await controlPlane
    .listTeams(ctx)
    .then((r) => teamsWithSummarySchema.parse(r))
    .catch(() => [])
  const teamsOf = new Map<string, TeamWithSummary[]>()
  await Promise.all(
    teams.map(async (team) => {
      const roster = await controlPlane
        .listTeamMembers<{ subject: string }[]>(ctx, team.id)
        .catch(() => [] as { subject: string }[])
      for (const entry of roster) {
        teamsOf.set(entry.subject, [...(teamsOf.get(entry.subject) ?? []), team])
      }
    })
  )

  // 행 모델은 서버에서 완성한다 — 위젯은 검색·필터·정렬만 하고 데이터를 다시 모으지 않는다.
  const rows: MemberRow[] = members.map((member) => ({
    subject: member.subject,
    role: member.role,
    addedAt: member.addedAt,
    ...(member.name ? { name: member.name } : {}),
    ...(member.email ? { email: member.email } : {}),
    ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
    teams: (teamsOf.get(member.subject) ?? []).map((team) => ({
      id: team.id,
      key: team.key,
      name: team.name,
    })),
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
