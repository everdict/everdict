'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'

import {
  createJudgeAction,
  validateJudgeAction,
  type ValidateJudgeResult,
} from '../api/register-judge'

const INPUTS = ['trace', 'dom', 'screenshot'] as const
type Kind = 'model' | 'harness'
// A judge's rubric comes in two shapes — inline freeform text or a registered-rubric reference {id, version}.
type RubricMode = 'inline' | 'registered'

// Linear-style segmented control — shared by the kind and rubric-mode toggles.
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-secondary/40 p-1 text-[13px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 whitespace-nowrap rounded-md px-3 py-1.5 transition-colors',
            value === o.value
              ? 'bg-card font-[510] text-foreground shadow-raise'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[12px] text-faint">{hint}</p>}
    </div>
  )
}

// Agent Judge registration form — kind (model | harness) toggle + conditional fields; dry-run validate, then register.
// runtimes = this workspace's runtimes (harness-judge execution infra; empty = co-locate only).
// rubrics = registered rubrics (owned + shared) for the registered-rubric mode selector.
// models = this workspace's registered LLM models — the model-kind judge picks its provider model from these (id ≠ model string).
export function RegisterJudgeForm({
  workspace,
  runtimes = [],
  rubrics = [],
  models = [],
}: {
  workspace: string
  runtimes?: { id: string }[]
  rubrics?: { id: string; owner: string }[]
  models?: { id: string; provider: string; model: string }[]
}) {
  const router = useRouter()
  const t = useTranslations('registerJudge')
  const [kind, setKind] = useState<Kind>('model')
  const [id, setId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [description, setDescription] = useState('')
  // model fields
  const [provider, setProvider] = useState('anthropic')
  const [model, setModel] = useState('claude-opus-4-8')
  const [inputs, setInputs] = useState<string[]>(['trace'])
  const [passThreshold, setPassThreshold] = useState('')
  // rubric (both kinds — model: required, harness: optional)
  const [rubricMode, setRubricMode] = useState<RubricMode>('inline')
  const [rubricText, setRubricText] = useState('')
  const [rubricId, setRubricId] = useState('')
  const [rubricVersion, setRubricVersion] = useState('latest')
  // harness fields
  const [harnessId, setHarnessId] = useState('')
  const [harnessVersion, setHarnessVersion] = useState('latest')
  const [runtime, setRuntime] = useState('')

  const [result, setResult] = useState<ValidateJudgeResult>()
  const [error, setError] = useState<string>()
  const [validating, startValidate] = useTransition()
  const [saving, startSave] = useTransition()

  // The rubric field in its wire shape — string (inline) | {id, version} (reference) | undefined (harness only).
  function rubricValue(): unknown {
    if (rubricMode === 'registered')
      return rubricId ? { id: rubricId, version: rubricVersion.trim() || 'latest' } : undefined
    return rubricText.trim() ? rubricText : undefined
  }

  function buildSpec(): unknown {
    const rubric = rubricValue()
    const common = {
      id: id.trim(),
      version: version.trim() || '1.0.0',
      ...(description.trim() ? { description: description.trim() } : {}),
      tags: [] as string[],
    }
    if (kind === 'model') {
      return {
        ...common,
        kind: 'model',
        provider,
        model: model.trim(),
        rubric,
        inputs,
        ...(passThreshold.trim() ? { passThreshold: Number(passThreshold) } : {}),
      }
    }
    return {
      ...common,
      kind: 'harness',
      harness: { id: harnessId.trim(), version: harnessVersion.trim() || 'latest' },
      ...(rubric !== undefined ? { rubric } : {}),
      ...(runtime ? { runtime } : {}),
    }
  }

  // Client-side required check (immediate feedback; the server enforces too). Returns a catalog key, null = pass.
  function requiredErrorKey(): string | null {
    if (!id.trim()) return 'errorIdRequired'
    if (!version.trim()) return 'errorVersionRequired'
    if (kind === 'model' && !model.trim()) return 'errorModelRequired'
    if (kind === 'model' && rubricValue() === undefined) return 'errorRubricRequired'
    if (kind === 'harness' && !harnessId.trim()) return 'errorHarnessRequired'
    return null
  }

  function precheck(): boolean {
    setError(undefined)
    const key = requiredErrorKey()
    if (key) {
      setError(t(key))
      return false
    }
    return true
  }

  function onValidate() {
    setResult(undefined)
    if (!precheck()) return
    startValidate(async () => {
      setResult(await validateJudgeAction(buildSpec()))
    })
  }

  function onSubmit() {
    if (!precheck()) return
    startSave(async () => {
      const r = await createJudgeAction(buildSpec())
      if (r.ok) {
        toast.success(t('registered', { id: r.id ?? '', version: r.version ?? '' }))
        router.push(`/${workspace}/judges`)
        router.refresh()
      } else {
        setError(r.error ?? t('errorGeneric'))
      }
    })
  }

  const busy = validating || saving
  const rubricRequired = kind === 'model'
  // Registered models for the currently-selected provider (de-duped by the underlying model string; id ≠ model).
  // Selecting one fills the judge's `model` field with that provider model string — the provider key still authenticates the call.
  const providerModels = Array.from(
    new Map(models.filter((m) => m.provider === provider).map((m) => [m.model, m])).values()
  )

  return (
    <div className="max-w-2xl space-y-6">
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          { value: 'model', label: t('kindModelLabel') },
          { value: 'harness', label: t('kindHarnessLabel') },
        ]}
      />

      <div className="grid grid-cols-2 gap-4">
        <Field label={t('idLabel')} hint={t('idHint')}>
          <Input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="correctness"
            autoComplete="off"
          />
        </Field>
        <Field label={t('versionLabel')} hint={t('versionHint')}>
          <Input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="1.0.0"
            autoComplete="off"
          />
        </Field>
      </div>

      <Field label={t('descriptionLabel')}>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('descriptionPlaceholder')}
          autoComplete="off"
        />
      </Field>

      {kind === 'model' && (
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('providerLabel')}>
            <Combobox
              value={provider}
              onChange={setProvider}
              options={[
                { value: 'anthropic', label: 'anthropic' },
                { value: 'openai', label: 'openai' },
              ]}
            />
          </Field>
          {/* Model — pick from the workspace's registered models for this provider; falls back to free text when none are registered. */}
          <div className="space-y-1.5">
            <Label>{t('modelLabel')}</Label>
            {providerModels.length > 0 ? (
              <Combobox
                value={model}
                onChange={setModel}
                placeholder={t('modelPickerPlaceholder')}
                options={providerModels.map((m) => ({ value: m.model, label: m.id, hint: m.model }))}
                aria-label={t('modelLabel')}
              />
            ) : (
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="claude-opus-4-8"
                autoComplete="off"
              />
            )}
            <p className="text-[12px] text-faint">
              {providerModels.length > 0 ? (
                t('modelPickerHint')
              ) : (
                <>
                  {t('modelNoneHint')}{' '}
                  <Link
                    href={`/${workspace}/settings?tab=models`}
                    className="font-[510] text-foreground underline underline-offset-2"
                  >
                    {t('registerModelCta')}
                  </Link>
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {kind === 'harness' && (
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('harnessIdLabel')}>
            <Input
              value={harnessId}
              onChange={(e) => setHarnessId(e.target.value)}
              placeholder="claude-code"
              autoComplete="off"
            />
          </Field>
          <Field label={t('harnessVersionLabel')}>
            <Input
              value={harnessVersion}
              onChange={(e) => setHarnessVersion(e.target.value)}
              placeholder="latest"
              autoComplete="off"
            />
          </Field>
        </div>
      )}

      {/* Rubric — inline text (frozen into this judge version) or a registered rubric reference (versioned separately). */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <Label>{rubricRequired ? t('rubricLabel') : t('rubricOptionalLabel')}</Label>
          <Segmented
            value={rubricMode}
            onChange={setRubricMode}
            options={[
              { value: 'inline', label: t('rubricModeInline') },
              { value: 'registered', label: t('rubricModeRegistered') },
            ]}
          />
        </div>
        {rubricMode === 'inline' ? (
          <Textarea
            className="min-h-28"
            value={rubricText}
            onChange={(e) => setRubricText(e.target.value)}
            placeholder={t('rubricTextPlaceholder')}
            aria-label={t('rubricLabel')}
          />
        ) : rubrics.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            {t('rubricEmptyHint')}{' '}
            <Link
              href={`/${workspace}/rubrics/new`}
              className="font-[510] text-foreground underline underline-offset-2"
            >
              {t('registerRubricCta')}
            </Link>
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('rubricSelectLabel')}>
              <Combobox
                value={rubricId}
                onChange={setRubricId}
                placeholder={t('rubricSelectPlaceholder')}
                options={rubrics.map((r) => ({
                  value: r.id,
                  hint: r.owner === '_shared' ? t('sharedHint') : undefined,
                }))}
              />
            </Field>
            <Field label={t('rubricVersionLabel')} hint={t('rubricVersionHint')}>
              <Input
                value={rubricVersion}
                onChange={(e) => setRubricVersion(e.target.value)}
                placeholder="latest"
                autoComplete="off"
              />
            </Field>
          </div>
        )}
      </div>

      {kind === 'model' && (
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('inputsLabel')}>
            <div className="flex h-8 items-center gap-4 text-[13px]">
              {INPUTS.map((o) => (
                <label key={o} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={inputs.includes(o)}
                    onChange={(e) =>
                      setInputs(e.target.checked ? [...inputs, o] : inputs.filter((x) => x !== o))
                    }
                    className="accent-primary"
                  />
                  {o}
                </label>
              ))}
            </div>
          </Field>
          <Field label={t('passThresholdLabel')}>
            <Input
              value={passThreshold}
              onChange={(e) => setPassThreshold(e.target.value)}
              placeholder="0.7"
              inputMode="decimal"
              autoComplete="off"
            />
          </Field>
        </div>
      )}

      {kind === 'harness' && (
        <Field label={t('runtimeLabel')} hint={t('runtimeHint')}>
          <Combobox
            value={runtime}
            onChange={setRuntime}
            options={[
              { value: '', label: t('runtimeDefaultOption') },
              ...runtimes.map((r) => ({ value: r.id })),
            ]}
          />
        </Field>
      )}

      {result && <ValidateBanner result={result} />}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      <div className="flex items-center gap-2.5 border-t border-border pt-5">
        <Button onClick={onSubmit} disabled={busy} className="gap-1.5">
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <CheckCircle2 className="size-4" />
          )}
          {saving ? t('submitting') : t('submit')}
        </Button>
        <Button variant="secondary" onClick={onValidate} disabled={busy} className="gap-1.5">
          {validating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ShieldCheck className="size-4" />
          )}
          {t('validate')}
        </Button>
        <Button variant="ghost" onClick={() => router.push(`/${workspace}/judges`)}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  )
}

function ValidateBanner({ result }: { result: ValidateJudgeResult }) {
  const t = useTranslations('registerJudge')
  if (result.error)
    return <Callout tone="danger">{t('validateFailed', { error: result.error })}</Callout>
  if (!result.ok)
    return (
      <Callout tone="danger">
        <div className="font-[510]">{t('validateSchemaErrors')}</div>
        <ul className="mt-1 list-disc pl-5">
          {result.errors?.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </Callout>
    )
  const existing = result.existingVersions ?? []
  return (
    <Callout tone="info">
      <div className="font-[510]">
        {t('validateOk', {
          kind: result.kind ?? '',
          id: result.id ?? '',
          version: result.version ?? '',
        })}{' '}
        {result.versionExists ? t('validateVersionExists') : t('validateNewVersion')}
      </div>
      <div className="mt-1 text-muted-foreground">
        {t('validateExisting', {
          versions: existing.length > 0 ? existing.join(', ') : t('validateNone'),
        })}
        {result.versionExists && ` ${t('validateConflictNote')}`}
      </div>
    </Callout>
  )
}
