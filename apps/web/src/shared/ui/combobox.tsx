'use client'

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { createPortal } from 'react-dom'

import { cn } from '@/shared/lib/utils'

// 트리거와 팝오버 사이 간격(px) — dropdown-menu 와 동일.
const GAP = 6

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
  // 트리거의 뷰포트 좌표. 팝오버는 body 로 포털링해 fixed 로 여기에 정렬한다 — 부모의 overflow-hidden
  // (예: 설정 카드 SettingsList, Dialog 콘텐츠) 에 잘리지 않도록. dropdown-menu 와 동일한 방식.
  const [rect, setRect] = useState<DOMRect | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const t = useTranslations('ui')

  // 트리거 좌표를 다시 잰다(열기·스크롤·리사이즈 시).
  function measure() {
    const el = rootRef.current
    if (el) setRect(el.getBoundingClientRect())
  }

  function toggle() {
    if (open) {
      setOpen(false)
      return
    }
    measure() // 열기 전에 좌표를 확보해 첫 페인트 깜빡임을 없앤다
    setOpen(true)
  }

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

  // Close on outside-click; reposition on scroll/resize while open.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const target = e.target as Node
      // 트리거 또는 포털된 콘텐츠 안의 클릭이면 유지(콘텐츠는 rootRef 의 DOM 자식이 아니다).
      if (rootRef.current?.contains(target) || contentRef.current?.contains(target)) return
      setOpen(false)
    }
    // 캡처 단계로 어떤 스크롤 컨테이너의 스크롤이든 따라잡는다.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
      document.removeEventListener('mousedown', onDown)
    }
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
        toggle()
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

  // 팝오버는 트리거 바로 아래에 fixed 로 뜬다 — 트리거와 같은 너비, align 에 따라 좌/우 정렬.
  const style: CSSProperties | undefined = rect
    ? {
        position: 'fixed',
        top: rect.bottom + GAP,
        width: rect.width,
        ...(align === 'end' ? { right: window.innerWidth - rect.right } : { left: rect.left }),
      }
    : undefined

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
        onClick={toggle}
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

      {open &&
        style &&
        createPortal(
          <div
            ref={contentRef}
            style={style}
            className={cn(
              'z-[110] min-w-[180px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-[13px] shadow-pop',
              'origin-top animate-in fade-in-0 zoom-in-95 duration-100',
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
          </div>,
          document.body
        )}
    </div>
  )
}
