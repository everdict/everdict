import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

import { cn } from '@/shared/lib/utils'

// Linear st. 필드 — 32px 높이, 6px 라운드, 13px, 차분한 surface + 인디고 포커스 ring.
const base =
  'w-full rounded-md border bg-card px-2.5 text-[13px] text-foreground shadow-raise transition-[border-color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:opacity-50'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(base, 'h-8', className)} {...props} />
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(base, 'min-h-24 py-2 font-mono leading-relaxed', className)}
      {...props}
    />
  )
}

// 드롭다운은 native <select>/<datalist> 대신 shared/ui/combobox 의 Combobox 를 쓴다(전역 일관 — Select 아톰 제거됨).

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-[13px] font-[510] text-foreground', className)} {...props} />
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-xs text-destructive">{message}</p>
}
