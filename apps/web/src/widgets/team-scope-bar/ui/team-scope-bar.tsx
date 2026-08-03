import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import {
  teamHref,
  TeamKeyBadge,
  teamSectionHref,
  type TeamSection,
  type TeamWithSummary,
} from '@/entities/team'
import { cn } from '@/shared/lib/utils'

// 팀 아래의 화면이 자기가 어디에 있는지 말하는 한 줄 — 브레드크럼(Teams › ENG)과, 그 팀이 **실제로 가진**
// 자원들의 탭. 팀마다 가진 것이 다르므로(트리아지를 켜지 않은 팀에는 인박스가 없다) 탭은 팀 레코드에서
// 만들어진다: 열어 봐야 비어 있는 자리를 미리 보여 주지 않는다.
//
// 이슈 상세의 브레드크럼과 같은 문법이고, 링크는 전부 lib/href 를 거친다(슬러그 결정은 한 곳).
export interface TeamScope {
  workspace: string
  team: TeamWithSummary
  // 지금 보고 있는 자리. 팀 홈은 'home'.
  section: TeamSection | 'home'
}

export async function TeamScopeBar({ scope }: { scope: TeamScope }) {
  const t = await getTranslations('nav')
  const directory = await getTranslations('teamsDirectory')
  const { workspace, team, section } = scope

  // 팀이 가진 자원만. 트리아지는 그 팀이 켰을 때만 존재한다.
  const sections: { key: TeamSection; label: string }[] = [
    { key: 'issues', label: t('issues') },
    ...(team.triageEnabled ? [{ key: 'triage' as const, label: t('triage') }] : []),
    { key: 'cycles', label: t('cycles') },
    { key: 'projects', label: t('projects') },
    { key: 'scorecards', label: t('scorecards') },
  ]

  return (
    <div className="space-y-2">
      <nav className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Link href={`/${workspace}/teams`} className="transition-colors hover:text-foreground">
          {directory('title')}
        </Link>
        <span aria-hidden>/</span>
        <Link
          href={teamHref(workspace, team.key)}
          className={cn(
            'inline-flex items-center gap-1.5 transition-colors hover:text-foreground',
            section === 'home' && 'text-foreground'
          )}
        >
          <TeamKeyBadge teamKey={team.key} />
          <span className="truncate">{team.name}</span>
        </Link>
      </nav>
      <div className="flex flex-wrap items-center gap-1">
        {sections.map((entry) => {
          const active = entry.key === section
          return (
            <Link
              key={entry.key}
              href={teamSectionHref(workspace, team.key, entry.key)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'rounded-md px-2 py-1 text-[12px] font-[510] transition-colors',
                active
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              {entry.label}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
