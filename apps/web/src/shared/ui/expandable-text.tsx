'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

// 긴 텍스트(에러 메시지·진행 과정 스텝 등)를 기본 몇 줄로 접어 두고, 실제로 넘칠 때만 "더 보기 / 접기"
// 토글로 사용자가 전체를 펼치게 하는 원자. 데이터에는 전체 텍스트가 담겨 있으므로 잘리지 않고,
// UI 로만 접어 두어 타임라인이 한 케이스의 긴 에러로 폭주하지 않는다. 짧은 텍스트엔 토글이 없다.
export function ExpandableText({
  text,
  prefix,
  className,
  clampLines = 3,
}: {
  text: string
  prefix?: ReactNode // 접힘 영역 안에서 텍스트 앞에 인라인으로 붙는 라벨(예: "error ·")
  className?: string
  clampLines?: number
}) {
  const t = useTranslations('ui')
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (el === null || expanded) return // 펼친 상태는 측정하지 않음(넘침 여부는 접혀 있을 때만 의미가 있다)
    // 접힌 상태에서 실제로 잘리는지 측정 — 넘칠 때만 토글을 노출한다. 뷰포트 폭이 바뀌면 다시 잰다.
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
