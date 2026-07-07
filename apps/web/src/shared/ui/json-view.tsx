'use client'

import { useState, type ReactNode } from 'react'
import { Check, ChevronRight, Copy } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { copyText } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'

// 구문강조 + 접기 가능한 JSON 트리. 코어 패키지 무의존(웹은 HTTP 미러만) — 임의 JSON 값을 그대로 도식 없이 검토.
// 색은 디자인 토큰 기반(키=인디고, 문자열=success, 숫자=warning, bool=link, null=faint).

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
  const [open, setOpen] = useState(depth < 2) // 상위 2단계는 펼침, 그 아래는 접힘 기본
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

export function JsonView({ value, className }: { value: unknown; className?: string }) {
  const t = useTranslations('ui')
  const locale = useLocale()
  const [copied, setCopied] = useState(false)
  const text = JSON.stringify(value, null, 2)

  async function copy() {
    // http(비-secure) 컨텍스트에선 navigator.clipboard 가 없어 copyText 가 execCommand 로 폴백한다.
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
      <pre className="overflow-auto p-4 pr-20 font-mono text-[12px] leading-[1.65]">
        <code>
          <Node value={value as Json} depth={0} trailingComma={false} />
        </code>
      </pre>
    </div>
  )
}
