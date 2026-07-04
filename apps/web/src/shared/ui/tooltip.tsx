'use client'

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { createPortal } from 'react-dom'

import { cn } from '@/shared/lib/utils'

// 커스텀 툴팁(Linear st. popover) — 가이드/안내 문구는 화면에 인라인 노출하지 않고,
// 트리거(주로 info 아이콘)에 호버/포커스했을 때만 보여준다. Combobox 처럼 의존성 없는 경량 구현.
// 콘텐츠는 body 포털 + fixed 배치 — overflow-hidden 컨테이너(설정 리스트 카드 등)나 스태킹
// 컨텍스트 안에서도 잘리지 않는다(트리거 rect 기준으로 열 때 좌표 계산, 스크롤/리사이즈 시 닫음).
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  className,
  contentClassName,
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  className?: string
  contentClassName?: string
}) {
  const [style, setStyle] = useState<CSSProperties>() // undefined = 닫힘
  const triggerRef = useRef<HTMLSpanElement>(null)

  function openAtTrigger() {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const transforms: string[] = []
    if (side === 'top') transforms.push('translateY(-100%)')
    if (align === 'center') transforms.push('translateX(-50%)')
    if (align === 'end') transforms.push('translateX(-100%)')
    setStyle({
      position: 'fixed',
      top: side === 'top' ? rect.top - 6 : rect.bottom + 6,
      left:
        align === 'center' ? rect.left + rect.width / 2 : align === 'end' ? rect.right : rect.left,
      ...(transforms.length > 0 ? { transform: transforms.join(' ') } : {}),
    })
  }
  const close = () => setStyle(undefined)

  // 열려 있는 동안 스크롤/리사이즈 → 좌표가 낡으므로 닫는다(호버 툴팁은 재계산보다 닫힘이 자연스럽다).
  useEffect(() => {
    if (!style) return
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [style])

  return (
    <span
      ref={triggerRef}
      className={cn('relative inline-flex', className)}
      onMouseEnter={openAtTrigger}
      onMouseLeave={close}
      onFocus={openAtTrigger}
      onBlur={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close()
      }}
    >
      {children}
      {style &&
        createPortal(
          <span
            role="tooltip"
            style={style}
            className={cn(
              'pointer-events-none z-50 w-max max-w-[300px] rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11.5px] leading-relaxed text-foreground shadow-pop',
              'animate-in fade-in-0 zoom-in-95 duration-100',
              contentClassName
            )}
          >
            {content}
          </span>,
          document.body
        )}
    </span>
  )
}

// info 아이콘 트리거 툴팁 — 안내 문구의 표준 노출 방식(인라인 캡션 금지).
export function InfoTip({
  content,
  side,
  align,
  className,
  'aria-label': ariaLabel = '도움말',
}: {
  content: ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  className?: string
  'aria-label'?: string
}) {
  return (
    <Tooltip
      content={content}
      {...(side ? { side } : {})}
      {...(align ? { align } : {})}
      {...(className ? { className } : {})}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        className="grid size-4.5 place-items-center rounded text-faint transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
      >
        <Info className="size-3.5" />
      </button>
    </Tooltip>
  )
}
