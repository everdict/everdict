'use client'

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/shared/lib/utils'

// Dependency-free lightweight dropdown menu (Linear st. popover). Closes on outside-click/Esc, aligned to the trigger.
const Ctx = createContext<{ close: () => void } | null>(null)

// 트리거와 팝오버 사이 간격(px). 예전의 mt-1.5/mb-1.5 를 fixed 좌표 계산으로 옮긴 값.
const GAP = 6

export function DropdownMenu({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  className,
  contentClassName,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
  className?: string
  contentClassName?: string
}) {
  const [open, setOpen] = useState(false)
  // 트리거의 뷰포트 좌표. 팝오버는 body 로 포털링해 fixed 로 여기에 정렬한다
  // (부모의 overflow-hidden 에 잘리지 않도록 — 예: 설정 카드 SettingsList).
  const [rect, setRect] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // 트리거 좌표를 다시 잰다(열기·스크롤·리사이즈 시).
  function measure() {
    const el = triggerRef.current
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

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const target = e.target as Node
      // 트리거 또는 포털된 콘텐츠 안의 클릭이면 유지(콘텐츠는 triggerRef 의 DOM 자식이 아니다).
      if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    // 캡처 단계로 어떤 스크롤 컨테이너의 스크롤이든 따라잡는다.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const style: CSSProperties | undefined = rect
    ? {
        position: 'fixed',
        ...(side === 'bottom'
          ? { top: rect.bottom + GAP }
          : { bottom: window.innerHeight - rect.top + GAP }),
        ...(align === 'end' ? { right: window.innerWidth - rect.right } : { left: rect.left }),
      }
    : undefined

  return (
    <div ref={triggerRef} className={cn('relative', className)}>
      {trigger({ open, toggle })}
      {open &&
        style &&
        createPortal(
          <Ctx.Provider value={{ close: () => setOpen(false) }}>
            <div
              ref={contentRef}
              role="menu"
              style={style}
              className={cn(
                'z-50 min-w-[200px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-[13px] shadow-pop',
                'animate-in fade-in-0 zoom-in-95 duration-100',
                side === 'bottom' ? 'origin-top' : 'origin-bottom',
                contentClassName
              )}
            >
              {children}
            </div>
          </Ctx.Provider>,
          document.body
        )}
    </div>
  )
}

export function DropdownItem({
  children,
  onSelect,
  icon,
  trailing,
  tone = 'default',
  className,
}: {
  children: ReactNode
  onSelect?: () => void
  icon?: ReactNode
  // 행 오른쪽 끝에 붙는 후행 슬롯(예: 선택 체크마크) — flex-1 라벨과 형제여야 같은 행에 정렬된다.
  trailing?: ReactNode
  tone?: 'default' | 'danger'
  className?: string
}) {
  const ctx = useContext(Ctx)
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onSelect?.()
        ctx?.close()
      }}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        tone === 'danger'
          ? 'text-destructive hover:bg-destructive/10 [&_svg]:text-destructive'
          : 'text-foreground hover:bg-accent',
        className
      )}
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {trailing}
    </button>
  )
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
      {children}
    </p>
  )
}

export function DropdownSeparator() {
  return <div className="my-1 h-px bg-border" />
}
