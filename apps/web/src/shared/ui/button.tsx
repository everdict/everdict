import type { ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/shared/lib/utils'

// Linear st. 컨트롤 — 낮은 높이(28~32px), 6px 라운드, weight 510, ease-out 트랜지션.
// primary 는 인디고 + 상단 인셋 하이라이트, hover 시 밝기 상승. active 1px 눌림.
export const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-[510] leading-none transition-[background,box-shadow,border-color,color,filter,transform] duration-150 ease-[var(--ease-out-cubic)] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(8,9,10,0.28),inset_0_1px_0_rgba(255,255,255,0.14)] hover:brightness-110',
        secondary:
          'border border-border bg-secondary text-secondary-foreground hover:bg-accent hover:text-foreground hover:border-border-strong',
        outline:
          'border border-border bg-transparent text-foreground hover:bg-accent hover:border-border-strong',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        subtle: 'bg-elevated text-foreground hover:bg-accent',
        destructive:
          'bg-destructive text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] hover:brightness-110',
      },
      size: {
        xs: 'h-7 gap-1 px-2 text-[12px] [&_svg]:size-3.5',
        sm: 'h-7 px-2.5 [&_svg]:size-4',
        md: 'h-8 px-3 [&_svg]:size-4',
        lg: 'h-9 px-4 text-sm [&_svg]:size-4',
        icon: 'size-8 [&_svg]:size-4',
        'icon-sm': 'size-7 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
)

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
