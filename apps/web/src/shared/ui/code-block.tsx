'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { copyText } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'

// 복사 가능한 커맨드/코드 블록 — mono `pre` + 우상단 복사 버튼. 커맨드는 코드이므로 번역하지 않고 그대로 노출한다.
// (copyText은 http 컨텍스트 폴백까지 처리; message=null → 토스트 없이 인라인 "copied" 상태만 사용)
export function CodeBlock({
  code,
  copyLabel, // 복사 버튼 aria-label (스크린리더용 — 번역 문자열 주입)
  className,
}: {
  code: string
  copyLabel: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={cn('relative rounded-lg border bg-muted/40', className)}>
      <pre className="overflow-x-auto px-3.5 py-3 pr-11 font-mono text-[12.5px] leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        aria-label={copyLabel}
        onClick={async () => {
          const ok = await copyText(code, null)
          if (!ok) return
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="absolute right-2 top-2 grid size-7 place-items-center rounded-md border border-border bg-background/80 text-muted-foreground transition-colors hover:text-foreground"
      >
        {copied ? <Check className="size-3.5 text-[var(--color-success)]" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}
