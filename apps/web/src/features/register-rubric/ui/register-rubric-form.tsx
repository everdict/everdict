'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, ListPlus, Loader2, ShieldCheck, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  createRubricAction,
  validateRubricAction,
  type ValidateRubricResult,
} from '../api/register-rubric'

// The custom prompt's placeholder vocabulary — code literals passed to ICU messages as arguments
// (literal braces inside a catalog string would be parsed as ICU arguments).
const VERDICT_PLACEHOLDER = '{verdict_instruction}'
const PROMPT_PLACEHOLDERS =
  '{task} {rubric} {criteria} {dom} {final_answer} {response} {trace} {verdict_instruction}'

interface CriterionRow {
  id: string
  description: string
  weight: string
  passThreshold: string
}

const EMPTY_ROW: CriterionRow = { id: '', description: '', weight: '', passThreshold: '' }

const csv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

// Form → RubricSpec. Empty optionals are excluded; numbers only when parseable (the server validates too).
function buildSpec(f: {
  id: string
  version: string
  description: string
  text: string
  criteria: CriterionRow[]
  promptTemplate: string
  tags: string
}): Record<string, unknown> {
  const t = (v: string) => v.trim()
  const num = (v: string): number | undefined => {
    const n = Number(t(v))
    return t(v) && Number.isFinite(n) ? n : undefined
  }
  const criteria = f.criteria
    .filter((c) => t(c.id) && t(c.description))
    .map((c) => ({
      id: t(c.id),
      description: t(c.description),
      ...(num(c.weight) !== undefined ? { weight: num(c.weight) } : {}),
      ...(num(c.passThreshold) !== undefined ? { passThreshold: num(c.passThreshold) } : {}),
    }))
  return {
    id: t(f.id),
    version: t(f.version) || '1.0.0',
    ...(t(f.description) ? { description: t(f.description) } : {}),
    ...(t(f.text) ? { text: t(f.text) } : {}),
    ...(criteria.length > 0 ? { criteria } : {}),
    ...(t(f.promptTemplate) ? { promptTemplate: t(f.promptTemplate) } : {}),
    tags: csv(f.tags),
  }
}

function Field({
  label,
  hint,
  trailing,
  children,
}: {
  label: string
  hint?: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <Label>{label}</Label>
        {trailing}
      </div>
      {children}
      {hint && <p className="text-[12px] text-faint">{hint}</p>}
    </div>
  )
}

// Rubric registration form — freeform text and/or criteria rows and/or a custom prompt template
// (at least one; the control plane enforces). Dry-run validate, then register.
export function RegisterRubricForm({ workspace }: { workspace: string }) {
  const router = useRouter()
  const t = useTranslations('registerRubric')
  const [id, setId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [description, setDescription] = useState('')
  const [text, setText] = useState('')
  const [criteria, setCriteria] = useState<CriterionRow[]>([])
  const [promptTemplate, setPromptTemplate] = useState('')
  const [tags, setTags] = useState('')

  const [result, setResult] = useState<ValidateRubricResult>()
  const [error, setError] = useState<string>()
  const [validating, startValidate] = useTransition()
  const [saving, startSave] = useTransition()

  const fields = { id, version, description, text, criteria, promptTemplate, tags }

  const setRow = (i: number, patch: Partial<CriterionRow>) =>
    setCriteria((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  // Client-side required check (immediate feedback; the server enforces too). Returns a catalog key, null = pass.
  function requiredErrorKey(): string | null {
    if (!id.trim()) return 'errorIdRequired'
    if (!version.trim()) return 'errorVersionRequired'
    // A row with only one of id/description filled would be silently dropped by buildSpec — surface it instead.
    if (criteria.some((c) => Boolean(c.id.trim()) !== Boolean(c.description.trim())))
      return 'errorCriterionIncomplete'
    const complete = criteria.filter((c) => c.id.trim() && c.description.trim())
    if (!text.trim() && complete.length === 0 && !promptTemplate.trim()) return 'errorBodyRequired'
    if (promptTemplate.trim() && !promptTemplate.includes(VERDICT_PLACEHOLDER))
      return 'errorVerdictPlaceholder'
    return null
  }

  function precheck(): boolean {
    setError(undefined)
    const key = requiredErrorKey()
    if (key) {
      setError(t(key, { verdict: VERDICT_PLACEHOLDER }))
      return false
    }
    return true
  }

  function onValidate() {
    setResult(undefined)
    if (!precheck()) return
    startValidate(async () => {
      setResult(await validateRubricAction(buildSpec(fields)))
    })
  }

  function onSubmit() {
    if (!precheck()) return
    startSave(async () => {
      const r = await createRubricAction(buildSpec(fields))
      if (r.ok) {
        toast.success(t('registered', { id: r.id ?? '', version: r.version ?? '' }))
        router.push(`/${workspace}/rubrics`)
        router.refresh()
      } else {
        setError(r.error ?? t('errorGeneric'))
      }
    })
  }

  const busy = validating || saving

  return (
    <div className="max-w-2xl space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('idLabel')} hint={t('idHint')}>
          <Input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="code-quality"
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

      <Field label={t('textLabel')} hint={t('textHint')}>
        <Textarea
          className="min-h-32"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('textPlaceholder')}
        />
      </Field>

      {/* Criteria editor — each complete row (id + description) becomes its own scored metric. */}
      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <Label>{t('criteriaLabel')}</Label>
          <InfoTip content={t('criteriaTip')} />
        </div>
        {criteria.length > 0 && (
          <div className="space-y-2">
            <div className="grid grid-cols-[7rem_1fr_4rem_5rem_1.75rem] gap-2 text-[11px] font-[510] uppercase tracking-wide text-faint">
              <span>{t('criterionId')}</span>
              <span>{t('criterionDescription')}</span>
              <span>{t('criterionWeight')}</span>
              <span>{t('criterionPassThreshold')}</span>
              <span />
            </div>
            {criteria.map((c, i) => (
              // Rows are positional edit slots (no natural key until the id is typed) — index keys are fine here.
              <div key={i} className="grid grid-cols-[7rem_1fr_4rem_5rem_1.75rem] gap-2">
                <Input
                  value={c.id}
                  onChange={(e) => setRow(i, { id: e.target.value })}
                  placeholder="accuracy"
                  autoComplete="off"
                  aria-label={t('criterionId')}
                />
                <Input
                  value={c.description}
                  onChange={(e) => setRow(i, { description: e.target.value })}
                  placeholder={t('criterionDescriptionPlaceholder')}
                  autoComplete="off"
                  aria-label={t('criterionDescription')}
                />
                <Input
                  value={c.weight}
                  onChange={(e) => setRow(i, { weight: e.target.value })}
                  placeholder="1"
                  inputMode="decimal"
                  autoComplete="off"
                  aria-label={t('criterionWeight')}
                />
                <Input
                  value={c.passThreshold}
                  onChange={(e) => setRow(i, { passThreshold: e.target.value })}
                  placeholder="0.7"
                  inputMode="decimal"
                  autoComplete="off"
                  aria-label={t('criterionPassThreshold')}
                />
                <button
                  type="button"
                  onClick={() => setCriteria((rows) => rows.filter((_, j) => j !== i))}
                  aria-label={t('removeCriterion')}
                  className="grid size-8 place-items-center rounded-md text-faint transition-colors hover:bg-elevated hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="gap-1.5"
          onClick={() => setCriteria((rows) => [...rows, { ...EMPTY_ROW }])}
        >
          <ListPlus className="size-4" />
          {t('addCriterion')}
        </Button>
      </div>

      <Field
        label={t('promptTemplateLabel')}
        trailing={
          <InfoTip
            content={t('promptTemplateTip', {
              placeholders: PROMPT_PLACEHOLDERS,
              verdict: VERDICT_PLACEHOLDER,
            })}
          />
        }
      >
        <Textarea
          className="min-h-32"
          value={promptTemplate}
          onChange={(e) => setPromptTemplate(e.target.value)}
          placeholder={t('promptTemplatePlaceholder', { verdict: VERDICT_PLACEHOLDER })}
        />
      </Field>

      <Field label={t('tagsLabel')} hint={t('commaSeparatedHint')}>
        <Input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="browser, safety"
          autoComplete="off"
        />
      </Field>

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
        <Button variant="ghost" onClick={() => router.push(`/${workspace}/rubrics`)}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  )
}

function ValidateBanner({ result }: { result: ValidateRubricResult }) {
  const t = useTranslations('registerRubric')
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
        {t('validateOk', { id: result.id ?? '', version: result.version ?? '' })}{' '}
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
