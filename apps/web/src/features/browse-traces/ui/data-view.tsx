'use client'

import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { copyText } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'
import { JsonTree } from '@/shared/ui/json-view'

// Payload viewers for the trace detail — a raw/JSON toggling I/O panel and an expandable attributes
// table. Both always expose copy (the raw value verbatim), so payloads can be replayed elsewhere.
// Payloads render IN FULL — never truncate the content itself (only collapsed one-line previews elide).

// Parse only JSON containers (object/array) — a bare number/string gains nothing from a tree view.
function parseJsonContainer(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

function safeStringify(value: unknown, pretty: boolean): string {
  try {
    const s = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
    return s ?? String(value)
  } catch {
    return String(value)
  }
}

// Full raw text of a value — strings verbatim (so copy gives the actual payload), else pretty JSON.
function rawValue(value: unknown): string {
  return typeof value === 'string' ? value : safeStringify(value, true)
}

// Compact icon button with an inline "copied" check. Text is lazy so big values stringify on click only.
export function CopyButton({
  text,
  className,
}: {
  text: string | (() => string)
  className?: string
}) {
  const t = useTranslations('ui')
  const locale = useLocale()
  const [copied, setCopied] = useState(false)

  async function copy() {
    const resolved = typeof text === 'function' ? text() : text
    if (await copyText(resolved, undefined, locale)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={t('copy')}
      title={t('copy')}
      className={cn(
        'inline-flex shrink-0 items-center rounded-md border border-border bg-card/80 p-1 text-muted-foreground transition-colors hover:text-foreground',
        className
      )}
    >
      {copied ? <Check className="size-3 text-[var(--color-success)]" /> : <Copy className="size-3" />}
    </button>
  )
}

// Tiny segmented control (RAW|JSON, table|JSON) — lighter than the underline Tabs for in-panel headers.
function ModeSwitch<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: ReadonlyArray<{ value: T; label: string }>
}) {
  return (
    <span className="inline-flex rounded-md border border-border bg-card p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'rounded-[4px] px-1.5 py-px text-[10px] font-[560] transition-colors',
            value === o.value
              ? 'bg-elevated text-foreground'
              : 'text-faint hover:text-muted-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  )
}

// One I/O payload — raw text by default, a pretty JSON tree when the payload parses as one, copy always.
export function IoPanel({ label, text, accent }: { label: string; text: string; accent?: boolean }) {
  const t = useTranslations('traceBrowser')
  const [mode, setMode] = useState<'raw' | 'json'>('raw')
  const parsed = useMemo(() => parseJsonContainer(text), [text])

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-2.5 py-1">
        <span
          className={cn(
            'text-[10px] uppercase tracking-wide',
            accent ? 'text-[#c5aef0]' : 'text-faint'
          )}
        >
          {label}
        </span>
        <span className="flex items-center gap-1.5">
          {parsed !== undefined && (
            <ModeSwitch
              value={mode}
              onChange={setMode}
              options={[
                { value: 'raw', label: t('viewRaw') },
                { value: 'json', label: t('viewJson') },
              ]}
            />
          )}
          <CopyButton text={text} />
        </span>
      </div>
      {mode === 'json' && parsed !== undefined ? (
        <JsonTree value={parsed} className="max-h-96 p-2.5 text-[11.5px]" />
      ) : (
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-foreground/85">
          {text}
        </div>
      )}
    </div>
  )
}

// The expanded body of one attribute — a JSON tree when the value is (or parses to) a container, else full text.
function ExpandedValue({ value, raw }: { value: unknown; raw: string }) {
  const parsed = useMemo(
    () =>
      typeof value === 'object' && value !== null
        ? value
        : typeof value === 'string'
          ? parseJsonContainer(value)
          : undefined,
    [value]
  )
  if (parsed !== undefined)
    return (
      <JsonTree
        value={parsed}
        className="mt-1.5 max-h-80 rounded-md border border-border/60 bg-card/50 p-2 text-[11px]"
      />
    )
  return (
    <div className="mt-1.5 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-card/50 p-2 font-mono text-[11px] leading-relaxed text-foreground/85">
      {raw}
    </div>
  )
}

function AttributeRow({ name, value }: { name: string; value: unknown }) {
  const [open, setOpen] = useState(false)
  const preview = useMemo(() => {
    const compact = (typeof value === 'string' ? value : safeStringify(value, false)).replace(
      /\s+/g,
      ' '
    )
    return compact.length > 300 ? `${compact.slice(0, 300)}…` : compact
  }, [value])
  // Anything that can't be read whole on one truncated line gets an expander.
  const expandable =
    (typeof value === 'object' && value !== null) ||
    (typeof value === 'string' && (value.length > 64 || value.includes('\n') || parseJsonContainer(value) !== undefined))

  return (
    <div className="group px-2.5 py-1.5 text-[12px]">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => expandable && setOpen((o) => !o)}
          aria-expanded={expandable ? open : undefined}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 text-left',
            !expandable && 'cursor-default'
          )}
        >
          {expandable ? (
            open ? (
              <ChevronDown className="size-3 shrink-0 text-faint" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-faint" />
            )
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
            {name}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums text-foreground/80">
            {preview}
          </span>
        </button>
        <CopyButton
          text={() => rawValue(value)}
          className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        />
      </div>
      {open && expandable && <ExpandedValue value={value} raw={rawValue(value)} />}
    </div>
  )
}

// Span attributes — a readable table (expandable rows, per-value copy) with a whole-object JSON mode.
export function AttributesView({
  attributes,
  className,
}: {
  attributes: Record<string, unknown>
  className?: string
}) {
  const t = useTranslations('traceBrowser')
  const [mode, setMode] = useState<'table' | 'json'>('table')
  const entries = Object.entries(attributes)
  if (entries.length === 0) return null

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] uppercase tracking-wide text-faint">
          {t('attributesCount', { count: entries.length })}
        </span>
        <span className="flex items-center gap-1.5">
          <ModeSwitch
            value={mode}
            onChange={setMode}
            options={[
              { value: 'table', label: t('viewTable') },
              { value: 'json', label: t('viewJson') },
            ]}
          />
          <CopyButton text={() => safeStringify(attributes, true)} />
        </span>
      </div>
      {mode === 'json' ? (
        <JsonTree
          value={attributes}
          className="mt-1 max-h-[480px] rounded-md border border-border p-2.5 text-[11.5px]"
        />
      ) : (
        <div className="mt-1 divide-y divide-border/60 rounded-md border border-border">
          {entries.map(([k, v]) => (
            <AttributeRow key={k} name={k} value={v} />
          ))}
        </div>
      )}
    </div>
  )
}
