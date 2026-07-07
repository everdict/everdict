'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// Lightweight tabs — Linear st. underline tabs (for switching sections like settings/account). Supports both controlled and uncontrolled.
const Ctx = createContext<{ value: string; setValue: (v: string) => void } | null>(null)

export function Tabs({
  defaultValue,
  value: controlled,
  onValueChange,
  children,
  className,
}: {
  defaultValue?: string
  value?: string
  onValueChange?: (v: string) => void
  children: ReactNode
  className?: string
}) {
  const [internal, setInternal] = useState(defaultValue ?? '')
  const value = controlled ?? internal
  const setValue = (v: string) => {
    if (controlled === undefined) setInternal(v)
    onValueChange?.(v)
  }
  return (
    <Ctx.Provider value={{ value, setValue }}>
      <div className={className}>{children}</div>
    </Ctx.Provider>
  )
}

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center gap-1 border-b border-border', className)} role="tablist">
      {children}
    </div>
  )
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('TabsTrigger must be used within Tabs')
  const active = ctx.value === value
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => ctx.setValue(value)}
      className={cn(
        '-mb-px border-b-2 px-3 py-2 text-[13px] font-[510] transition-colors',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

export function TabsContent({ value, children }: { value: string; children: ReactNode }) {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('TabsContent must be used within Tabs')
  if (ctx.value !== value) return null
  return <div role="tabpanel">{children}</div>
}
