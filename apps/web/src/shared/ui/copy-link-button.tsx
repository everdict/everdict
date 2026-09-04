'use client'

import { useState } from 'react'
import { Check, Link2 } from 'lucide-react'
import { useLocale } from 'next-intl'

import { copyText } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'

// Copies the address of the page being viewed. The value is not taken as a prop because a server component does not know the ORIGIN —
// passing only the path makes a half link that cannot be pasted. The redirect to the canonical address has already happened by then, so
// location.href IS the address that may be shared (for an issue, `/{workspace}/issues/ENG-12`).
export function CopyLinkButton({
  label,
  message,
  className,
}: {
  label: string
  message?: string | null
  className?: string
}) {
  const locale = useLocale()
  const [copied, setCopied] = useState(false)

  async function copy() {
    // The clipboard helper handles the http (non-secure) context fallback too.
    if (await copyText(window.location.href, message, locale)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={label}
      className={cn(
        'rounded p-1 text-faint transition-colors hover:bg-accent hover:text-foreground',
        className
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-[var(--color-success)]" />
      ) : (
        <Link2 className="size-3.5" />
      )}
    </button>
  )
}
