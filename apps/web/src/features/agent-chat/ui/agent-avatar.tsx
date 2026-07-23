import { Sparkles } from 'lucide-react'

import { cn } from '@/shared/lib/utils'

// The agent's identity mark — a refined indigo spark (app-icon rounded square + soft glow), not a generic robot
// face. Used for the assistant avatar, the conversation header, and the typing indicator so the AI reads as
// premium and on-brand rather than "chatbot".
export function AgentAvatar({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-[7px] bg-gradient-to-br from-primary to-primary/70 text-white',
        'shadow-[0_1px_3px_rgba(94,106,210,0.45),inset_0_1px_0_rgba(255,255,255,0.25)]',
        size === 'sm' ? 'size-5 [&_svg]:size-3' : 'size-6 [&_svg]:size-[15px]',
        className
      )}
    >
      <Sparkles strokeWidth={2} className="drop-shadow-sm" />
    </span>
  )
}
