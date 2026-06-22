import type { ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/shared/lib/utils'

export const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 rounded-lg text-sm font-medium transition-[background,box-shadow,border-color,color,transform,filter] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // Linear st.: 인디고 그라데이션 + 상단 하이라이트 + 미세 섀도, hover 시 밝기 상승
        primary:
          'bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(8,9,10,0.24),inset_0_1px_0_rgba(255,255,255,0.16)] hover:brightness-110',
        secondary:
          'border border-border bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground',
        outline:
          'border border-border bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
      },
      size: { md: 'h-10 px-4', sm: 'h-8 px-3 text-[13px]', icon: 'size-9' },
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
