'use client'

import { useState, type ReactNode } from 'react'
import { Check, ChevronRight, Copy } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { copyText } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'

// Syntax-highlighted + collapsible JSON tree. No core-package dependency (web is an HTTP mirror only) — inspect arbitrary JSON values as-is without a schema.
// Colors are design-token based (key=indigo, string=success, number=warning, bool=link, null=faint).

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

function isObject(v: Json): v is { [k: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function Punct({ children }: { children: ReactNode }) {
  return <span className="text-faint">{children}</span>
}

function Leaf({ value }: { value: string | number | boolean | null }) {
  if (value === null) return <span className="text-faint italic">null</span>
  if (typeof value === 'string')
    return <span className="text-[var(--color-success)] break-all">&quot;{value}&quot;</span>
  if (typeof value === 'number')
    return <span className="text-[var(--color-warning)] tabular-nums">{value}</span>
  return <span className="text-link">{String(value)}</span>
}

function Key({ name }: { name: string }) {
  return <span className="text-[var(--color-accent-foreground)]">&quot;{name}&quot;</span>
}

function Node({
  value,
  depth,
  trailingComma,
}: {
  value: Json
  depth: number
  trailingComma: boolean
}) {
  const [open, setOpen] = useState(depth < 2) // top 2 levels expanded, deeper collapsed by default
  const comma = trailingComma ? <Punct>,</Punct> : null

  if (Array.isArray(value) || isObject(value)) {
    const entries: Array<[string | null, Json]> = Array.isArray(value)
      ? value.map((v) => [null, v] as [string | null, Json])
      : Object.entries(value)
    const [openB, closeB] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
    const empty = entries.length === 0

    if (empty)
      return (
        <span>
          <Punct>
            {openB}
            {closeB}
          </Punct>
          {comma}
        </span>
      )

    return (
      <span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="group/btn inline-flex items-center gap-0.5 rounded hover:bg-elevated"
          aria-expanded={open}
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-faint transition-transform group-hover/btn:text-muted-foreground',
              open && 'rotate-90'
            )}
          />
          <Punct>{openB}</Punct>
        </button>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mx-1 rounded px-1 text-[11px] text-faint ring-1 ring-inset ring-border hover:text-muted-foreground"
          >
            {entries.length}
            {Array.isArray(value) ? ' items' : ' keys'}
          </button>
        )}
        {open && (
          <span className="block">
            {entries.map(([k, v], i) => (
              <span key={k ?? i} className="block pl-[1.125rem]">
                {k !== null && (
                  <>
                    <Key name={k} />
                    <Punct>: </Punct>
                  </>
                )}
                <Node value={v} depth={depth + 1} trailingComma={i < entries.length - 1} />
              </span>
            ))}
          </span>
        )}
        <span className={cn(open && 'block')}>
          <Punct>{closeB}</Punct>
          {comma}
        </span>
      </span>
    )
  }

  return (
    <span>
      <Leaf value={value} />
      {comma}
    </span>
  )
}

// The bare collapsible tree (no frame, no copy button) — for embedding into a host that provides
// its own chrome (e.g. the trace I/O panels and attribute rows).
export function JsonTree({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cn('overflow-auto font-mono text-[12px] leading-[1.65]', className)}>
      <code>
        <Node value={value as Json} depth={0} trailingComma={false} />
      </code>
    </pre>
  )
}

export function JsonView({ value, className }: { value: unknown; className?: string }) {
  const t = useTranslations('ui')
  const locale = useLocale()
  const [copied, setCopied] = useState(false)
  const text = JSON.stringify(value, null, 2)

  async function copy() {
    // In an http (non-secure) context navigator.clipboard is absent, so copyText falls back to execCommand.
    if (await copyText(text, undefined, locale)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }
  }

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border border-border bg-[var(--color-muted)]/60',
        className
      )}
    >
      <button
        type="button"
        onClick={copy}
        className="absolute right-2.5 top-2.5 z-10 inline-flex items-center gap-1 rounded-md border border-border bg-card/80 px-2 py-1 text-[11px] font-[510] text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
      >
        {copied ? (
          <>
            <Check className="size-3 text-[var(--color-success)]" /> {t('copied')}
          </>
        ) : (
          <>
            <Copy className="size-3" /> {t('copy')}
          </>
        )}
      </button>
      <JsonTree value={value} className="p-4 pr-20" />
    </div>
  )
}
