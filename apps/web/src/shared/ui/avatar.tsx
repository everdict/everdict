import { cn } from '@/shared/lib/utils'
import { Tooltip } from '@/shared/ui/tooltip'

// Name → deterministic tone (indigo-family palette). Used for workspace/user monogram avatars.
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
  url?: string // uploaded/external avatar image (if present, shown instead of the monogram)
  size?: keyof typeof SIZES
  className?: string
}) {
  if (url) {
    return (
      // A mix of uploaded data URLs and external URLs, so use a plain img rather than next/image (remote-domain whitelist).
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

// Standard (uniform) creator display for cards/lists: show **only the round thumbnail** and put the name in a hover tooltip.
// No inline name alongside it; the position is standardized to the card's top-right (right of the title row).
export function UserAvatar({
  name,
  url,
  label,
  size = 'sm',
  className,
}: {
  name: string
  url?: string
  label?: string // tooltip prefix (creator/runner, etc.)
  size?: keyof typeof SIZES
  className?: string // wrapper (for layout — shrink-0, etc.)
}) {
  return (
    <Tooltip content={label ? `${label} · ${name}` : name} align="end" className={className}>
      <Avatar name={name} url={url} size={size} className="rounded-full" />
    </Tooltip>
  )
}
