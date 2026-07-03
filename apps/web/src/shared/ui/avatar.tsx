import { cn } from '@/shared/lib/utils'
import { Tooltip } from '@/shared/ui/tooltip'

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
  url,
  size = 'md',
  className,
}: {
  name: string
  url?: string // 업로드/외부 아바타 이미지(있으면 모노그램 대신 표시)
  size?: keyof typeof SIZES
  className?: string
}) {
  if (url) {
    return (
      // 업로드 data URL/외부 URL 혼용이라 next/image(원격 도메인 화이트리스트)가 아닌 일반 img 를 쓴다.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={name}
        className={cn(
          'shrink-0 object-cover ring-1 ring-inset ring-border',
          SIZES[size],
          className
        )}
      />
    )
  }
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

// 카드/목록의 작성자 표기 표준(일괄): **둥근 썸네일만** 노출하고 이름은 호버 툴팁으로.
// 인라인 이름 병기 금지, 위치는 카드 우상단(타이틀 행 오른쪽)으로 통일한다.
export function UserAvatar({
  name,
  url,
  label,
  size = 'sm',
  className,
}: {
  name: string
  url?: string
  label?: string // 툴팁 접두(만든이/실행자 등)
  size?: keyof typeof SIZES
  className?: string // 래퍼(배치용 — shrink-0 등)
}) {
  return (
    <Tooltip content={label ? `${label} · ${name}` : name} align="end" className={className}>
      <Avatar name={name} url={url} size={size} className="rounded-full" />
    </Tooltip>
  )
}
