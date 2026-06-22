import { cn } from '@/shared/lib/utils'

// 이름 → 결정적 색조(인디고 계열 팔레트). 워크스페이스/유저 모노그램 아바타에 사용.
const TONES = [
  'bg-[#5e6ad2]/18 text-[#9aa2ec] ring-[#5e6ad2]/30',
  'bg-[#4cb782]/18 text-[#5fd29a] ring-[#4cb782]/30',
  'bg-[#fc7840]/18 text-[#fc9a6e] ring-[#fc7840]/30',
  'bg-[#4ea7ff]/18 text-[#7cc0ff] ring-[#4ea7ff]/30',
  'bg-[#eb5757]/18 text-[#f08585] ring-[#eb5757]/30',
  'bg-[#f0bf00]/18 text-[#e6c54d] ring-[#f0bf00]/30',
] as const

function toneFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return TONES[h % TONES.length]
}

function monogram(name: string): string {
  const c = name.trim()[0]
  return (c ?? '?').toUpperCase()
}

const SIZES = {
  sm: 'size-5 text-[10px] rounded-[5px]',
  md: 'size-6 text-[11px] rounded-md',
  lg: 'size-7 text-[13px] rounded-md',
} as const

export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string
  size?: keyof typeof SIZES
  className?: string
}) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center font-[560] ring-1 ring-inset',
        SIZES[size],
        toneFor(name),
        className
      )}
      aria-hidden
    >
      {monogram(name)}
    </span>
  )
}
