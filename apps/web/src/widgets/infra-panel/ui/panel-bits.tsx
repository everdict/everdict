'use client'

import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useTranslations } from 'next-intl'

// Shared scaffolding for the panel's OWN navigation — infra drill-ins (runtime / runner / schedule / live run)
// open inside the panel, so every detail view gets the same back row. There is deliberately NO "full page"
// link: the panel shows the full content itself and never routes the left half to an infra page.

export function DetailNav({ onBack }: { onBack: () => void }) {
  const t = useTranslations('infraPanel')
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[12px] font-[510] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('backToList')}
      </button>
    </div>
  )
}

// A compact label/value row — hide-empty is the caller's job (render only when the value exists).
export function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="shrink-0 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
        {label}
      </span>
      <span className="min-w-0 truncate text-right font-mono text-[11.5px]">{children}</span>
    </div>
  )
}

// A drill-in section heading (same look as the list-section headings).
export function SectionLabel({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="flex items-center gap-1.5 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
      {children}
      {count !== undefined && <span className="tabular-nums text-muted-foreground">{count}</span>}
    </div>
  )
}
