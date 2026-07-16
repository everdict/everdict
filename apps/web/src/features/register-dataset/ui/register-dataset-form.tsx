'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { versionsForId } from '@/shared/lib/semver'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { VersionField } from '@/shared/ui/version-field'

import {
  createDatasetAction,
  validateDatasetAction,
  type CreateDatasetResult,
  type ValidateDatasetResult,
} from '../api/register-dataset'

// Sample to help fill in cases. Grading is chosen at run time (the scorecard's graders/judges), so a case is
// usually pure data: id · env · task · expected. For an LLM judge, `expected` holds the evaluation criteria.
const SAMPLE_CASES = `[
  {
    "id": "case-1",
    "env": { "kind": "prompt" },
    "task": "Write an email declining a refund request.",
    "expected": "Polite tone; states the reason clearly; offers at least one alternative."
  }
]`

// Prefill that the detail view's "create new version" feeds with the existing version's content — versions are immutable, so editing = a new version.
export interface DatasetPrefill {
  id: string
  description?: string
  tags?: string[]
  casesText: string
}

export function RegisterDatasetForm({
  existingDatasets = [],
  prefill,
  lockId = false,
}: {
  existingDatasets?: { id: string; versions: string[] }[]
  prefill?: DatasetPrefill
  lockId?: boolean
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const t = useTranslations('registerDataset')
  const [id, setId] = useState(prefill?.id ?? '')
  const [version, setVersion] = useState('1.0.0')
  const existing = versionsForId(existingDatasets, id)
  const [description, setDescription] = useState(prefill?.description ?? '')
  const [tagsText, setTagsText] = useState((prefill?.tags ?? []).join(', '))
  const [casesText, setCasesText] = useState(prefill?.casesText ?? SAMPLE_CASES)
  const [result, setResult] = useState<ValidateDatasetResult>()
  const [createError, setCreateError] = useState<string>()
  const [busy, setBusy] = useState(false)

  // Form → control plane Dataset body. cases parses the JSON text (the caller handles a parse failure).
  function buildDataset(): unknown {
    return {
      id,
      version,
      ...(description ? { description } : {}),
      cases: JSON.parse(casesText),
      tags: tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    }
  }

  async function onValidate() {
    setBusy(true)
    setCreateError(undefined)
    let body: unknown
    try {
      body = buildDataset()
    } catch {
      setBusy(false)
      setResult({ ok: false, error: t('casesParseError') })
      return
    }
    // Guard so busy clears even if the action send itself fails (body size exceeded, etc.).
    try {
      setResult(await validateDatasetAction(body))
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
    setBusy(false)
  }

  async function onCreate() {
    setBusy(true)
    setCreateError(undefined)
    let body: unknown
    try {
      body = buildDataset()
    } catch {
      setBusy(false)
      setCreateError(t('casesParseError'))
      return
    }
    let res: CreateDatasetResult
    try {
      res = await createDatasetAction(body)
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    setBusy(false)
    if (res.ok) {
      // When publishing a new version (prefill entry), return to that dataset's detail — the just-published version is now latest.
      if (lockId) router.push(`/${workspace}/datasets/${encodeURIComponent(id)}`)
      else router.push(`/${workspace}/datasets`)
    } else setCreateError(res.error ?? t('createError'))
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="id">{t('idLabel')}</Label>
        <Input
          id="id"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="repo-smoke"
          readOnly={lockId}
          className={cn(lockId && 'opacity-60')}
        />
      </div>
      <VersionField existing={existing} value={version} onChange={setVersion} />

      <div className="space-y-1.5">
        <Label htmlFor="description">{t('descriptionLabel')}</Label>
        <Input
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('descriptionPlaceholder')}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tags">{t('tagsLabel')}</Label>
        <Input
          id="tags"
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="coding, smoke"
        />
        <p className="text-[12px] text-muted-foreground">{t('tagsHelp')}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cases">{t('casesLabel')}</Label>
        <Textarea
          id="cases"
          className="min-h-72 text-[12px]"
          value={casesText}
          onChange={(e) => setCasesText(e.target.value)}
          spellCheck={false}
        />
        <p className="text-[12px] leading-relaxed text-muted-foreground">{t('casesHelp')}</p>
      </div>

      {result && <ValidateBanner result={result} />}
      {createError && <Callout tone="danger">{createError}</Callout>}

      <p className="text-[12px] leading-relaxed text-muted-foreground">{t('immutableNote')}</p>

      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onValidate} disabled={busy}>
          {busy ? '…' : t('validate')}
        </Button>
        <Button type="button" onClick={onCreate} disabled={busy}>
          {busy ? t('processing') : lockId ? t('submitNewVersion') : t('submit')}
        </Button>
      </div>
    </div>
  )
}

function ValidateBanner({ result }: { result: ValidateDatasetResult }) {
  const t = useTranslations('registerDataset')
  if (result.error)
    return <Callout tone="danger">{t('validateFailed', { error: result.error })}</Callout>
  if (!result.ok)
    return (
      <Callout tone="danger">
        <div className="font-[510]">{t('formatError')}</div>
        <ul className="mt-1 list-disc pl-5">
          {result.errors?.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </Callout>
    )
  return (
    <Callout tone="info">
      <div className="font-[510]">
        {t('formatOk', {
          id: result.id ?? '',
          version: result.version ?? '',
          cases: result.cases ?? 0,
        })}{' '}
        {result.versionExists ? t('versionExistsMarker') : t('versionNewMarker')}
      </div>
      <div className="mt-1 text-muted-foreground">
        {t('existingVersionsLabel')}{' '}
        {result.existingVersions && result.existingVersions.length > 0
          ? result.existingVersions.join(', ')
          : t('none')}
        {result.versionExists && t('versionExistsNote')}
      </div>
    </Callout>
  )
}
