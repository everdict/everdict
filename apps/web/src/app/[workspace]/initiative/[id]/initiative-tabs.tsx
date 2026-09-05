'use client'

import { useSelectedLayoutSegment } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { INITIATIVE_SECTIONS, initiativeHref, type InitiativeSection } from '@/entities/initiative'
import { cn } from '@/shared/lib/utils'
import { Link } from '@/shared/ui/link'

// The goal detail's tabs. Split into three places as Linear does — overview / projects / updates — with the header and attribute column carried
// by the LAYOUT, so moving between tabs never removes "which goal am I looking at" from the screen.
//
// Active state is decided by SEGMENT — comparing path strings goes wrong easily over a workspace slug or an encoded id.
// The overview is the place with no child segment (null).
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
