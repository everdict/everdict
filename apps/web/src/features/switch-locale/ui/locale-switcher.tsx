'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Languages } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { LOCALES, type Locale } from '@/shared/i18n/config'
import { reloadInfraFrames } from '@/shared/lib/reload-infra-frames'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { setLocale } from '../api/set-locale'

// Language switcher — status icon + click dropdown convention. Two shapes:
//  - 'row' (default): a full-width sidebar-footer row (icon + label + current).
//  - 'compact': a bordered pill (icon + current) for a settings-list row's right-side control, where the row already labels it.
// The choice is stored in a cookie and applied immediately, down to server component strings, via router.refresh.
export function LocaleSwitcher({
  rowClassName,
  variant = 'row',
}: {
  rowClassName?: string
  variant?: 'row' | 'compact'
}) {
  const t = useTranslations('locale')
  const locale = useLocale()
  const router = useRouter()
  const [, startTransition] = useTransition()

  function choose(next: Locale) {
    startTransition(async () => {
      await setLocale(next)
      router.refresh()
      // Re-render the infra panel's mounted iframes too — they resolve the locale server-side off the cookie
      // and router.refresh() does not reach their separate browsing context.
      reloadInfraFrames()
    })
  }

  if (variant === 'compact') {
    return (
      <DropdownMenu
        side="bottom"
        align="end"
        contentClassName="min-w-[160px]"
        trigger={({ toggle }) => (
          <button
            type="button"
            onClick={toggle}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[13px] text-foreground transition-colors hover:bg-accent"
          >
            <Languages className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            {t(locale)}
          </button>
        )}
      >
        {LOCALES.map((l) => (
          <DropdownItem
            key={l}
            onSelect={() => choose(l)}
            trailing={l === locale ? <Check /> : undefined}
          >
            {t(l)}
          </DropdownItem>
        ))}
      </DropdownMenu>
    )
  }

  return (
    <DropdownMenu
      side="top"
      contentClassName="min-w-[160px]"
      trigger={({ toggle }) => (
        <button type="button" onClick={toggle} className={cn('w-full text-left', rowClassName)}>
          <Languages className="size-[17px] shrink-0" strokeWidth={1.75} />
          {t('label')}
          <span className="ml-auto text-[11px] text-muted-foreground">{t(locale)}</span>
        </button>
      )}
    >
      {LOCALES.map((l) => (
        <DropdownItem
          key={l}
          onSelect={() => choose(l)}
          trailing={l === locale ? <Check /> : undefined}
        >
          {t(l)}
        </DropdownItem>
      ))}
    </DropdownMenu>
  )
}
