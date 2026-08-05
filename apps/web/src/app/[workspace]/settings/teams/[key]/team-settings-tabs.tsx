'use client'

import { useSelectedLayoutSegment } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { TEAM_SETTINGS_SECTIONS, teamSettingsHref, type TeamSettingsSection } from '@/entities/team'
import { cn } from '@/shared/lib/utils'
import { Link } from '@/shared/ui/link'

// 팀 설정의 탭 — 한 팀에게 묻는 서로 다른 질문들. 머리글은 레이아웃이 이고 있으므로, 탭을 옮겨도 "어느 팀을
// 고치는 중인지"는 화면에서 사라지지 않는다.
//
// 활성 판정은 세그먼트로 한다(경로 문자열 비교는 워크스페이스 슬러그나 인코딩된 키 때문에 어긋나기 쉽다).
// 일반 설정은 자식 세그먼트가 없는 자리(null)다.
export function TeamSettingsTabs({ workspace, teamKey }: { workspace: string; teamKey: string }) {
  const t = useTranslations('manageTeams')
  const segment = useSelectedLayoutSegment()
  const active: TeamSettingsSection =
    TEAM_SETTINGS_SECTIONS.find((section) => section === segment) ?? 'general'

  return (
    <nav className="flex items-center gap-1 border-b border-border" aria-label={t('tabsLabel')}>
      {TEAM_SETTINGS_SECTIONS.map((section) => (
        <Link
          key={section}
          href={teamSettingsHref(workspace, teamKey, section)}
          aria-current={section === active ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-[13px] font-[510] transition-colors',
            section === active
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          {t(`tab.${section}`)}
        </Link>
      ))}
    </nav>
  )
}
