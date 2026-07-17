'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { TraceSourceConfig } from '@/entities/trace-source'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { CodeEditor } from '@/shared/ui/code-editor'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'

import {
  createJudgeAction,
  validateJudgeAction,
  type ValidateJudgeResult,
} from '../api/register-judge'
import { JudgePreviewPanel } from './judge-preview-panel'

type Language = 'python' | 'node'

// Starter templates — the code contract in runnable form: read the context (argv[1] JSON with
// {case, trace, snapshot, evidence}), optionally call the judge model via the injected env, print Score[] last.
const PYTHON_STARTER = `import json, os, sys, urllib.request

ctx = json.load(open(sys.argv[1]))  # {case, trace, snapshot, evidence}
answer = (ctx.get("evidence") or {}).get("finalAnswer", "")

def llm(prompt):
    # EVERDICT_JUDGE_MODEL / ANTHROPIC_API_KEY are injected from this judge's Model binding
    req = urllib.request.Request(
        os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com") + "/v1/messages",
        method="POST",
        headers={
            "x-api-key": os.environ["ANTHROPIC_API_KEY"],
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        data=json.dumps({
            "model": os.environ["EVERDICT_JUDGE_MODEL"],
            "max_tokens": 512,
            "messages": [{"role": "user", "content": prompt}],
        }).encode(),
    )
    return json.load(urllib.request.urlopen(req))["content"][0]["text"]

scores = []
for m in ctx["case"].get("milestones") or []:
    verdict = llm(f"Expectation: {m['description']}\\nTrace: {json.dumps(ctx['trace'])[:6000]}\\nSatisfied? yes/no")
    ok = "yes" in verdict.lower()
    scores.append({"graderId": "judge", "metric": f"judge:milestone:{m['id']}", "value": 1 if ok else 0, "pass": ok})

ok = bool(answer)
scores.insert(0, {"graderId": "judge", "metric": "judge", "value": 1 if ok else 0, "pass": ok})
print(json.dumps(scores))
`

const NODE_STARTER = `import { readFileSync } from 'node:fs'

const ctx = JSON.parse(readFileSync(process.argv[2], 'utf8')) // {case, trace, snapshot, evidence}
const answer = ctx.evidence?.finalAnswer ?? ''

// EVERDICT_JUDGE_MODEL + ANTHROPIC_API_KEY / OPENAI_API_KEY are injected from this judge's Model binding.
const ok = answer.length > 0
console.log(JSON.stringify([{ graderId: 'judge', metric: 'judge', value: ok ? 1 : 0, pass: ok }]))
`

const STARTERS: Record<Language, string> = { python: PYTHON_STARTER, node: NODE_STARTER }

// Linear-style segmented control (language toggle).
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

// Code-judge registration — THE judge authoring surface: user Python/Node code renders the verdict from the full
// judge context, sandboxed via dispatch. (model/harness judges remain engine-internal for already-registered specs.)
// runtimes = this workspace's runtimes (judge execution infra; empty = co-locate only).
// models = registered LLM models — the optional Model binding the code may call (env-injected at dispatch).
export function RegisterJudgeForm({
  workspace,
  runtimes = [],
  models = [],
  sources = [],
  assignments = {},
}: {
  workspace: string
  runtimes?: { id: string }[]
  models?: { id: string; provider: string; model: string }[]
  sources?: TraceSourceConfig[]
  assignments?: Record<string, string>
}) {
  const router = useRouter()
  const t = useTranslations('registerJudge')
  const [id, setId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [description, setDescription] = useState('')
  const [language, setLanguage] = useState<Language>('python')
  const [code, setCode] = useState<string>(PYTHON_STARTER)
  const [model, setModel] = useState('')
  const [runtime, setRuntime] = useState('')
  const [image, setImage] = useState('')
  const [timeoutSec, setTimeoutSec] = useState('')

  const [result, setResult] = useState<ValidateJudgeResult>()
  const [error, setError] = useState<string>()
  const [validating, startValidate] = useTransition()
  const [saving, startSave] = useTransition()

  // Switching language swaps the starter only while the code is still an untouched starter (never clobber edits).
  function onLanguage(next: Language) {
    setLanguage(next)
    if (code === STARTERS[language] || code.trim() === '') setCode(STARTERS[next])
  }

  function buildSpec(): unknown {
    return {
      kind: 'code',
      id: id.trim(),
      version: version.trim() || '1.0.0',
      ...(description.trim() ? { description: description.trim() } : {}),
      language,
      code,
      ...(model ? { model: { ref: model } } : {}),
      ...(runtime ? { runtime } : {}),
      ...(image.trim() ? { image: image.trim() } : {}),
      ...(timeoutSec.trim() ? { timeoutSec: Number(timeoutSec) } : {}),
      tags: [] as string[],
    }
  }

  // Client-side required check (immediate feedback; the server enforces too). Returns a catalog key, null = pass.
  function requiredErrorKey(): string | null {
    if (!id.trim()) return 'errorIdRequired'
    if (!version.trim()) return 'errorVersionRequired'
    if (!code.trim()) return 'errorCodeRequired'
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

  return (
    <div className="max-w-3xl space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('idLabel')} hint={t('idHint')}>
          <Input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e2e-booking"
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

      {/* The code — the judge itself. Contract: argv[1] = context JSON path; print Score[] last on stdout. */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <Label>{t('codeLabel')}</Label>
          <Segmented
            value={language}
            onChange={onLanguage}
            options={[
              { value: 'python', label: 'Python' },
              { value: 'node', label: 'Node.js' },
            ]}
          />
        </div>
        <CodeEditor
          value={code}
          onChange={setCode}
          language={language}
          minHeight="360px"
          aria-label={t('codeLabel')}
        />
        <p className="text-[12px] text-faint">{t('codeHint')}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Optional Model binding — injected as EVERDICT_JUDGE_MODEL/PROVIDER + the provider key env at dispatch. */}
        <Field label={t('modelOptionalLabel')} hint={t('modelEnvHint')}>
          <Combobox
            value={model}
            onChange={setModel}
            placeholder={t('modelNonePlaceholder')}
            options={[
              { value: '', label: t('modelNoneOption') },
              ...models.map((m) => ({ value: m.id, hint: `${m.provider}/${m.model}` })),
            ]}
            aria-label={t('modelOptionalLabel')}
          />
        </Field>
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
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label={t('imageLabel')} hint={t('imageHint')}>
          <Input
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="ghcr.io/acme/judge:1 (everdict-baked)"
            autoComplete="off"
            className="font-mono text-[12px]"
          />
        </Field>
        <Field label={t('timeoutLabel')} hint={t('timeoutHint')}>
          <Input
            value={timeoutSec}
            onChange={(e) => setTimeoutSec(e.target.value)}
            placeholder="600"
            inputMode="numeric"
            autoComplete="off"
          />
        </Field>
      </div>

      {result && <ValidateBanner result={result} />}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      <div className="border-t border-border pt-5">
        <JudgePreviewPanel getSpec={buildSpec} sources={sources} assignments={assignments} />
      </div>

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
