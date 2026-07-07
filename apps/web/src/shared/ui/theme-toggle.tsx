'use client'

import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

// 라이트/다크 토글. next-themes 없이 html.dark 클래스 + localStorage 만으로 동작한다.
// 초기 클래스는 layout 의 no-flash 스크립트가 페인트 전에 세팅한다.
export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations('ui')
  const [dark, setDark] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'))
    setMounted(true)
  }, [])

  function toggle() {
    const next = !document.documentElement.classList.contains('dark')
    document.documentElement.classList.toggle('dark', next)
    document.documentElement.style.colorScheme = next ? 'dark' : 'light'
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light')
    } catch {
      // localStorage 차단 환경: 메모리 상태로만 토글
    }
    setDark(next)
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t('themeToggleAria')}
      title={dark ? t('lightMode') : t('darkMode')}
      className={cn(
        'inline-grid size-9 place-items-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
    >
      <span suppressHydrationWarning className="grid">
        {mounted && dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
      </span>
    </button>
  )
}
