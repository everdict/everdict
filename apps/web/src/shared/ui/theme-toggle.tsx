'use client'

import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

// Light/dark toggle. Works with just the html.dark class + localStorage, no next-themes.
// The initial class is set before paint by layout's no-flash script.
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
      // localStorage-blocked environment: toggle via in-memory state only
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
