'use client'

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

// Option — value is the form value, label is the display (unset=value), hint is the secondary info on the right (owner/alias resolution, etc.),
// description is a one-line description under the option (in the dropdown list only; the trigger stays concise, label only),
// keywords is extra text used only for search matching.
export interface ComboboxOption {
  value: string
  label?: ReactNode
  hint?: ReactNode
  description?: ReactNode
  keywords?: string
}

// The canonical dropdown selector (Linear st. popover) — replaces the poverty of native <select> and datalist comboboxes.
// Dependency-free lightweight implementation: close on outside-click/Esc, search (automatic when there are many options), keyboard nav (↑↓·Enter·Esc).
// A value not in the existing options is still surfaced verbatim on the trigger (preserves system defaults, etc.).
export function Combobox({
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  searchPlaceholder,
  searchable,
  disabled,
  id,
  className,
  contentClassName,
  align = 'start',
  'aria-label': ariaLabel,
}: {
  options: ComboboxOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  emptyText?: string
  searchPlaceholder?: string
  searchable?: boolean
  disabled?: boolean
  id?: string
  className?: string
  contentClassName?: string
  align?: 'start' | 'end'
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const t = useTranslations('ui')

  // When unset, catalog defaults (select…/no items/search…) — if the caller passes them, use those verbatim.
  const placeholderText = placeholder ?? t('comboboxPlaceholder')
  const emptyLabel = emptyText ?? t('comboboxEmpty')
  const searchPlaceholderText = searchPlaceholder ?? t('comboboxSearch')

  const showSearch = searchable ?? options.length > 7
  const selected = options.find((o) => o.value === value)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => {
      const label = typeof o.label === 'string' ? o.label : ''
      return `${o.value} ${label} ${o.keywords ?? ''}`.toLowerCase().includes(q)
    })
  }, [options, query])

  // Close on outside-click.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // On open: focus the search + highlight the currently selected item. On close: reset the query.
  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const idx = options.findIndex((o) => o.value === value)
    setActive(idx >= 0 ? idx : 0)
    if (showSearch) searchRef.current?.focus()
    // React only to the open toggle (value/options are intentionally excluded — a snapshot at the moment of opening).
  }, [open])

  // When the search results change, move the highlight back to the top.
  useEffect(() => {
    setActive(0)
  }, [query])

  // Scroll so the highlight is always visible.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({
      block: 'nearest',
    })
  }, [active, open])

  function commit(opt: ComboboxOption) {
    onChange(opt.value)
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return // Leave Enter/Space to the native button toggle.
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[active]
      if (opt) commit(opt)
    }
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={cn(
          'flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-card px-2.5 text-[13px] text-foreground shadow-raise transition-[border-color,box-shadow]',
          'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25',
          open && 'border-primary ring-2 ring-ring/25',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      >
        <span className={cn('truncate', !value && 'text-muted-foreground/60')}>
          {selected ? (selected.label ?? selected.value) : value || placeholderText}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground/70" />
      </button>

      {open && (
        <div
          className={cn(
            'absolute top-full z-50 mt-1.5 w-full min-w-[180px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-[13px] shadow-pop',
            'origin-top animate-in fade-in-0 zoom-in-95 duration-100',
            align === 'end' ? 'right-0' : 'left-0',
            contentClassName
          )}
        >
          {showSearch && (
            <div className="mb-1 flex items-center gap-1.5 border-b border-border px-1.5 pb-1.5 pt-0.5">
              <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={searchPlaceholderText}
                className="h-6 w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
              />
            </div>
          )}
          <div ref={listRef} role="listbox" id={listId} className="max-h-60 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                {emptyLabel}
              </p>
            ) : (
              filtered.map((opt, idx) => {
                const isSelected = opt.value === value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-idx={idx}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => commit(opt)}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                      idx === active ? 'bg-accent' : 'hover:bg-accent/60'
                    )}
                  >
                    <Check
                      className={cn(
                        'mt-0.5 size-3.5 shrink-0 text-primary',
                        isSelected ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-foreground">{opt.label ?? opt.value}</span>
                        {opt.hint != null && (
                          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                            {opt.hint}
                          </span>
                        )}
                      </span>
                      {opt.description != null && (
                        <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
