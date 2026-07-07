'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Languages } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { LOCALES, type Locale } from '@/shared/i18n/config'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { setLocale } from '../api/set-locale'

// 언어 전환 — 상태 아이콘 + 클릭 드롭다운 컨벤션(테마 토글 옆, 사이드바 푸터 행 스타일).
// 선택은 쿠키로 저장되고 router.refresh 로 서버 컴포넌트 문자열까지 즉시 반영된다.
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
        <DropdownItem key={l} onSelect={() => choose(l)}>
          <span className="flex-1">{t(l)}</span>
          {l === locale && <Check className="size-3.5" />}
        </DropdownItem>
      ))}
    </DropdownMenu>
  )
}
