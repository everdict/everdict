'use client'

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Input } from '@/shared/ui/input'

// A declared evidence requirement (mirror of the control plane's EvidenceRequirement). name → tool_call/span, role → artifact.
export interface Requirement {
  kind: string
  name?: string
  role?: string
}

const KINDS = ['final_answer', 'tool_call', 'dom', 'screenshot', 'artifact', 'span'] as const
const TAKES_NAME = new Set(['tool_call', 'span'])
const TAKES_ROLE = new Set(['artifact'])

// Editor for a judge's declared evidence requirements — what the judge NEEDS from a run to render a sound verdict.
// The preview panel checks these against a sample trace (satisfied/missing), so a user sees gaps before registering.
export function RequiresEditor({
  value,
  onChange,
}: {
  value: Requirement[]
  onChange: (next: Requirement[]) => void
}) {
  const t = useTranslations('judgeRequires')
  const [kind, setKind] = useState<string>('final_answer')
  const [detail, setDetail] = useState('')

  function add() {
    const req: Requirement = { kind }
    if (TAKES_NAME.has(kind) && detail.trim()) req.name = detail.trim()
    if (TAKES_ROLE.has(kind) && detail.trim()) req.role = detail.trim()
    // span requires a name — skip an empty one (the control plane would reject it anyway).
    if (kind === 'span' && !req.name) return
    onChange([...value, req])
    setDetail('')
  }

  const needsDetail = TAKES_NAME.has(kind) || TAKES_ROLE.has(kind)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Combobox
          value={kind}
          onChange={setKind}
          options={KINDS.map((k) => ({ value: k, label: t(`kind_${k}`) }))}
          className="w-44"
        />
        {needsDetail ? (
          <Input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder={TAKES_ROLE.has(kind) ? t('rolePlaceholder') : t('namePlaceholder')}
            className="w-48"
          />
        ) : null}
        <Button type="button" variant="secondary" size="sm" onClick={add} className="gap-1">
          <Plus className="size-3.5" />
          {t('add')}
        </Button>
      </div>

      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((r, i) => (
            <span
              key={`${r.kind}-${r.name ?? r.role ?? ''}-${i}`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[12px]"
            >
              {r.kind}
              {r.name ? `:${r.name}` : r.role ? `:${r.role}` : ''}
              <button
                type="button"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('remove')}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">{t('empty')}</p>
      )}
    </div>
  )
}
