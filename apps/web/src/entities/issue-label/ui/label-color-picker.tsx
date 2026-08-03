'use client'

import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

import { ISSUE_LABEL_COLORS, type IssueLabelColor } from '../model/schema'
import { LabelDot } from './label-chip'

// 색은 닫힌 팔레트에서만 고른다 — hex 입력을 주면 다크에서 안 보이는 라벨을 누구나 만들 수 있다(차트와 같은
// 규칙: 지어낸 색은 없다). 라벨을 만드는 표면이 둘이라(설정의 라벨 관리자, 이슈 화면의 선택기) 고르는 물건도
// 하나여야 한다 — 좁은 팝오버용은 `size="sm"`.
export function LabelColorPicker({
  value,
  onChange,
  labelledBy,
  ariaLabel,
  size = 'md',
}: {
  value: IssueLabelColor
  onChange: (next: IssueLabelColor) => void
  labelledBy?: string
  ariaLabel?: string
  size?: 'sm' | 'md'
}) {
  const t = useTranslations('tracker')
  return (
    <div
      role="radiogroup"
      {...(labelledBy !== undefined ? { 'aria-labelledby': labelledBy } : {})}
      {...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {})}
      className={cn('flex flex-wrap', size === 'sm' ? 'gap-1' : 'gap-1.5')}
    >
      {ISSUE_LABEL_COLORS.map((color) => {
        const name = t(`labelColor.${color}`)
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={color === value}
            aria-label={name}
            title={name}
            onClick={() => onChange(color)}
            className={cn(
              'grid place-items-center rounded-md border transition-colors',
              size === 'sm' ? 'size-6' : 'size-7',
              color === value
                ? 'border-primary bg-primary/10'
                : 'border-border hover:border-border-strong'
            )}
          >
            <LabelDot color={color} className={size === 'sm' ? 'size-2.5' : 'size-3'} />
          </button>
        )
      })}
    </div>
  )
}
