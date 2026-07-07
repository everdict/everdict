'use client'

import { useMemo, useState, useTransition } from 'react'
import { Eye, EyeOff, KeyRound } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Textarea } from '@/shared/ui/input'

import { createSecretAction } from '../api/create-secret'

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

export type SecretPickerScope = 'user' | 'workspace'

// Secret-reference picker — choose from the loaded secret names, or create one inline via "New" and use that name as the reference.
// The raw value never lands in the form/spec (only the name is stored). Inputs that take a secret name use this picker instead of free text
// (harness env · GHE App private key · Mattermost token …).
export function SecretPicker({
  value,
  onChange,
  names,
  scope,
  onCreated,
  hint,
  defaultMultiline,
  createValuePlaceholder,
  id,
  'aria-label': ariaLabel,
}: {
  value: string
  onChange: (name: string) => void
  names: string[] // this scope's secret names, preloaded server-side (values not included)
  scope: SecretPickerScope // tier where an inline-created secret is stored (personal/workspace)
  onCreated?: (name: string) => void // notify on inline creation — when the parent shares the list across multiple pickers
  hint?: React.ReactNode // note shown below the selected value (hidden while the create form is open)
  defaultMultiline?: boolean // secret whose value is multi-line by default, like PEM/kubeconfig
  createValuePlaceholder?: string
  id?: string
  'aria-label'?: string
}) {
  const t = useTranslations('pickSecret')
  const [creating, setCreating] = useState(false)
  // An inline-created secret is added to the options immediately (server preload + new).
  const [created, setCreated] = useState<string[]>([])
  const options = useMemo(() => [...new Set([...names, ...created])].sort(), [names, created])
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Combobox
          id={id}
          value={value}
          onChange={onChange}
          options={options.map((n) => ({ value: n }))}
          placeholder={options.length > 0 ? t('selectSecret') : t('noSecrets')}
          emptyText={t('emptyText')}
          className="flex-1"
          aria-label={ariaLabel ?? t('selectSecret')}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="shrink-0 gap-1"
          onClick={() => setCreating((c) => !c)}
        >
          <KeyRound className="size-3.5" /> {t('new')}
        </Button>
      </div>
      {value && !creating && hint}
      {creating && (
        <CreateSecretInline
          scope={scope}
          defaultMultiline={defaultMultiline ?? false}
          valuePlaceholder={createValuePlaceholder ?? t('secretValue')}
          onDone={(name) => {
            setCreated((c) => [...c, name])
            onCreated?.(name)
            onChange(name)
            setCreating(false)
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  )
}

// Inline secret creation — name (env format) + value → after saving, the parent selects that name as the reference. scope stores it as personal/shared.
// Name/value are stacked vertically so it fits even in a narrow container (a form grid cell).
function CreateSecretInline({
  scope,
  defaultMultiline,
  valuePlaceholder,
  onDone,
  onCancel,
}: {
  scope: SecretPickerScope
  defaultMultiline: boolean
  valuePlaceholder: string
  onDone: (name: string) => void
  onCancel: () => void
}) {
  const t = useTranslations('pickSecret')
  const [name, setName] = useState('')
  const [val, setVal] = useState('')
  const [show, setShow] = useState(false)
  const [multiline, setMultiline] = useState(defaultMultiline) // toggle for a multi-line value like PEM/kubeconfig
  const [error, setError] = useState<string>()
  const [pending, start] = useTransition()
  const nameInvalid = name.length > 0 && !NAME_RE.test(name)

  function save() {
    setError(undefined)
    start(async () => {
      const r = await createSecretAction(name, val, scope)
      if (r.ok) onDone(name)
      else setError(r.error ?? t('saveFailed'))
    })
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 p-2.5">
      <p className="text-[11px] text-muted-foreground">
        {scope === 'user' ? t('scopeUser') : t('scopeWorkspace')}
      </p>
      <div className="space-y-1">
        <span className="text-[11px] text-muted-foreground">{t('nameEnvFormat')}</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="OPENAI_API_KEY"
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-[12px]"
        />
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">{t('value')}</span>
          <button
            type="button"
            className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setMultiline((v) => !v)}
          >
            {multiline ? t('toSingleLine') : t('toMultiline')}
          </button>
        </div>
        {multiline ? (
          <Textarea
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder={valuePlaceholder}
            rows={4}
            spellCheck={false}
            className="font-mono text-[12px]"
          />
        ) : (
          <div className="relative">
            <Input
              type={show ? 'text' : 'password'}
              value={val}
              onChange={(e) => setVal(e.target.value)}
              placeholder={valuePlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="pr-8 text-[12px]"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? t('hideValue') : t('showValue')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
            >
              {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
        )}
      </div>
      {nameInvalid && <p className="text-[11px] text-destructive">{t('nameInvalid')}</p>}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending || name.length === 0 || val.length === 0 || nameInvalid}
          onClick={save}
        >
          {pending ? t('saving') : t('saveSecret')}
        </Button>
        <button
          type="button"
          className="text-[12px] text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          {t('cancel')}
        </button>
        <span className="text-[11px] text-faint">{t('valueOnce')}</span>
      </div>
    </div>
  )
}
