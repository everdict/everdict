'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

// The atom that folds long text (an error message, the steps of a process) to a few lines by default and offers a "show more / show less"
// toggle only when it ACTUALLY overflows, so a user can expand the whole thing. The data holds the full text, so nothing is truncated —
// the folding is UI only, which stops one case's long error from flooding the timeline. Short text gets no toggle.
export function ExpandableText({
  text,
  prefix,
  className,
  clampLines = 3,
}: {
  text: string
  prefix?: ReactNode // an inline label placed before the text inside the folded region (e.g. "error ·")
  className?: string
  clampLines?: number
}) {
  const t = useTranslations('ui')
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (el === null || expanded) return // an expanded state is not measured (overflow only means something while folded)
    // Measure whether it is actually clipped while folded — the toggle appears only when it overflows. Re-measured when the viewport width changes.
    const measure = () => setOverflows(el.scrollHeight - el.clientHeight > 1)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [text, clampLines, expanded])

  return (
    <div className="min-w-0">
      <div
        ref={ref}
        className={cn(className, !expanded && 'overflow-hidden')}
        style={
          expanded
            ? undefined
            : { display: '-webkit-box', WebkitLineClamp: clampLines, WebkitBoxOrient: 'vertical' }
        }
      >
        {prefix}
        {text}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-[510] text-link transition-colors hover:text-foreground"
        >
          {expanded ? t('showLess') : t('showMore')}
        </button>
      )}
    </div>
  )
}
