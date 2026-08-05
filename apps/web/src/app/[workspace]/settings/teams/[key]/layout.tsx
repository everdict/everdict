import type { ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'

import { TeamKeyBadge } from '@/entities/team'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

import { loadTeamSettings } from './load-team'
import { TeamSettingsTabs } from './team-settings-tabs'

export const dynamic = 'force-dynamic'

// Settings › Teams › {team} — 한 팀의 설정. 리니어처럼 **탭 라우트**다: 이 레이아웃이 사라지면 안 되는 것
// (어느 팀인지 · 목록으로 돌아가는 길 · 탭)을 이고 있고, 각 탭이 자기 page.tsx 로 몸통만 갈아 끼운다.
//
// 예전에는 이 네 가지가 한 장에 쌓여 있었고 순서까지 어긋나 있었다 — 팀이 무엇인지 말하기도 전에 보드 컬럼
// 편집기가 맨 위에 있었다. 무엇을 고치는 중인지는 화면의 위치가 말해야 한다.
export default async function TeamSettingsLayout({
  children,
  params,
}: {
  children: ReactNode
  // 팀은 키로 주소를 갖는다(`/settings/teams/ENG`) — 일하는 화면과 같은 슬러그다. 제어 평면이 id 도 받으므로
  // 예전 uuid 링크는 그대로 열린다.
  params: Promise<{ workspace: string; key: string }>
}) {
  const { workspace, key } = await params
  const t = await getTranslations('manageTeams')
  const s = await getTranslations('settingsPage')
  const { team, canRead, error } = await loadTeamSettings(key)

  const backToList = (
    <Link
      href={`/${workspace}/settings/teams`}
      className={buttonVariants({ size: 'sm', variant: 'ghost' })}
    >
      {t('backToTeams')}
    </Link>
  )

  if (!canRead)
    return (
      <div className="space-y-5">
        <PageHeader title={t('tab.general')} actions={backToList} />
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )

  // 읽지 못한 팀은 레이아웃이 한 번 말한다 — 아래 탭은 같은 실패를 두 번 말하지 않고 null 을 그린다.
  if (!team)
    return (
      <div className="space-y-5">
        <PageHeader title={t('tab.general')} actions={backToList} />
        <Callout tone="danger">{s('connectError', { error: error ?? '' })}</Callout>
      </div>
    )

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="inline-flex min-w-0 items-center gap-2">
            <TeamKeyBadge teamKey={team.key} />
            <span className="truncate">{team.name}</span>
          </span>
        }
        actions={backToList}
      />
      <TeamSettingsTabs workspace={workspace} teamKey={team.key} />
      {children}
    </div>
  )
}
