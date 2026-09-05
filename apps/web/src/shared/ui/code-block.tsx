'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { copyText } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'

// A copyable command/code block — a mono `pre` plus a copy button at the top right. A command is CODE, so it is shown untranslated.
// (copyText handles the http-context fallback too; message=null → no toast, only the inline "copied" state)
export function CodeBlock({
  code,
  copyLabel, // the copy button's aria-label (for screen readers — a translated string is injected)
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
