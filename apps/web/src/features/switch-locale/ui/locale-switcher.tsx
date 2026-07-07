'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Languages } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { LOCALES, type Locale } from '@/shared/i18n/config'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { setLocale } from '../api/set-locale'

// Language switcher — status icon + click dropdown convention (next to the theme toggle, sidebar footer row style).
// The choice is stored in a cookie and applied immediately, down to server component strings, via router.refresh.
export function LocaleSwitcher({ rowClassName }: { rowClassName?: string }) {
  const t = useTranslations('locale')
  const locale = useLocale()
  const router = useRouter()
  const [, startTransition] = useTransition()

  function choose(next: Locale) {
    startTransition(async () => {
      await setLocale(next)
      router.refresh()
    })
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
