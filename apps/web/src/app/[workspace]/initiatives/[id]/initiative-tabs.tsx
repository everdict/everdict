'use client'

import Link from 'next/link'
import { useSelectedLayoutSegment } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { INITIATIVE_SECTIONS, initiativeHref, type InitiativeSection } from '@/entities/initiative'
import { cn } from '@/shared/lib/utils'

// 목표 상세의 탭. 리니어처럼 개요 / 프로젝트 / 업데이트 세 자리로 나뉘고, 헤더와 속성 열은 레이아웃이
// 이고 있으므로 탭을 옮겨도 "어느 목표를 보고 있는지"는 화면에서 사라지지 않는다.
//
// 활성 판정은 세그먼트로 한다 — 경로 문자열 비교는 워크스페이스 슬러그나 인코딩된 id 때문에 어긋나기 쉽다.
// 개요는 자식 세그먼트가 없는 자리(null)다.
export function InitiativeTabs({ workspace, id }: { workspace: string; id: string }) {
  const t = useTranslations('initiativesPage')
  const segment = useSelectedLayoutSegment()
  const active: InitiativeSection =
    INITIATIVE_SECTIONS.find((section) => section === segment) ?? 'overview'

  return (
    <nav className="flex items-center gap-1 border-b border-border" aria-label={t('tabsLabel')}>
      {INITIATIVE_SECTIONS.map((section) => (
        <Link
          key={section}
          href={initiativeHref(workspace, id, section)}
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
