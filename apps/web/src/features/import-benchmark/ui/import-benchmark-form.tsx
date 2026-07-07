'use client'

import { useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { versionsForId } from '@/shared/lib/semver'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { VersionField } from '@/shared/ui/version-field'

import { importBenchmarkAction, type ImportBenchmarkResult } from '../api/import-benchmark'

// GET /benchmarks 항목(컨트롤플레인 카탈로그). source=huggingface 는 ID 인출, jsonl 은 파일 업로드 필요.
export interface BenchmarkCatalogItem {
  id: string
  category: string
  source: 'huggingface' | 'jsonl'
  gated: boolean
  defaultVersion: string
  description: string
}

// GET /benchmark-recipes 항목(테넌트/_shared 레시피, 데이터).
export interface RecipeItem {
  id: string
  owner: string
  versions: string[]
}

interface Entry {
  value: string // "catalog:<id>" | "recipe:<id>"
  kind: 'catalog' | 'recipe'
  id: string
  label: string
  source?: 'huggingface' | 'jsonl'
  gated?: boolean
  description?: string
}

export function ImportBenchmarkForm({
  benchmarks,
  recipes = [],
  existingDatasets = [],
  preselect,
}: {
  benchmarks: BenchmarkCatalogItem[]
  recipes?: RecipeItem[]
  existingDatasets?: { id: string; versions: string[] }[]
  preselect?: string // "recipe:<id>" — 레시피 상세에서 진입 시 초기 선택.
}) {
  const t = useTranslations('importBenchmark')
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const entries: Entry[] = useMemo(
    () => [
      ...benchmarks.map((b) => ({
        value: `catalog:${b.id}`,
        kind: 'catalog' as const,
        id: b.id,
        label: `${b.id} · ${b.category}${b.gated ? ' · gated' : ''}${b.source === 'jsonl' ? ` · ${t('fileUpload')}` : ''}`,
        source: b.source,
        gated: b.gated,
        description: b.description,
      })),
      ...recipes.map((r) => ({
        value: `recipe:${r.id}`,
        kind: 'recipe' as const,
        id: r.id,
        label: `${r.id} · ${t('recipe')}${r.owner === '_shared' ? ` (${t('sharedSuffix')})` : ''}`,
      })),
    ],
    [benchmarks, recipes, t]
  )

  const [sel, setSel] = useState(
    preselect && entries.some((e) => e.value === preselect) ? preselect : (entries[0]?.value ?? '')
  )
  const [datasetId, setDatasetId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [limit, setLimit] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportBenchmarkResult>()

  const selected = useMemo(() => entries.find((e) => e.value === sel), [entries, sel])
  const catalogJsonl = selected?.kind === 'catalog' && selected.source === 'jsonl'

  async function onImport() {
    if (!selected) return
    setBusy(true)
    setResult(undefined)
    const body: Record<string, unknown> = { version }
    if (selected.kind === 'recipe') body.recipe = { id: selected.id }
    else body.benchmark = selected.id
    if (datasetId) body.id = datasetId
    if (limit && Number.isFinite(Number(limit))) body.limit = Number(limit)
    if (catalogJsonl && !text.trim()) {
      setBusy(false)
      setResult({ ok: false, error: t('jsonlRequired') })
      return
    }
    if (text.trim()) body.text = text
    const res = await importBenchmarkAction(body)
    setBusy(false)
    setResult(res)
    if (res.ok) router.push(`/${workspace}/datasets`)
  }

  if (entries.length === 0) {
    return <p className="text-[13px] text-muted-foreground">{t('nothingToImport')}</p>
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-1.5">
        <Label htmlFor="benchmark">{t('benchmarkOrRecipe')}</Label>
        {/* optgroup 대응 — 카탈로그/레시피 구분은 우측 hint 로(그룹 헤더 없는 flat 리스트) */}
        <Combobox
          id="benchmark"
          value={sel}
          onChange={setSel}
          options={entries.map((e) => ({
            value: e.value,
            label: e.label,
            hint: e.kind === 'catalog' ? t('catalog') : t('myRecipe'),
            keywords: e.kind === 'catalog' ? 'catalog first-party' : 'recipe workspace',
          }))}
          className="w-full"
        />
        {selected?.description && (
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {selected.description}
          </p>
        )}
      </div>

      {selected?.gated && (
        <Callout tone="warning">
          {t.rich('gatedNotice', { code: (chunks) => <code>{chunks}</code> })}
        </Callout>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="datasetId">{t('datasetIdOptional')}</Label>
        <Input
          id="datasetId"
          value={datasetId}
          onChange={(e) => setDatasetId(e.target.value)}
          placeholder={selected?.id ?? 'id'}
        />
      </div>
      <VersionField
        existing={versionsForId(existingDatasets, datasetId.trim() || selected?.id || '')}
        value={version}
        onChange={setVersion}
      />

      {!catalogJsonl && (
        <div className="space-y-1.5">
          <Label htmlFor="limit">{t('maxCasesOptional')}</Label>
          <Input
            id="limit"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder={t('maxCasesPlaceholder')}
            inputMode="numeric"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="text">
          {t('jsonlContent')} {catalogJsonl ? t('required') : t('jsonlOnlyRecipes')}
        </Label>
        <Textarea
          id="text"
          className="min-h-40 text-[12px]"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder='{"id":"ex--0","web":"https://example.com","ques":"...","answer":"...","web_name":"..."}'
        />
      </div>

      {result && !result.ok && (
        <Callout tone="danger">{t('importFailed', { error: result.error ?? '' })}</Callout>
      )}
      {result?.ok && (
        <Callout tone="info">
          {t('importSuccess', {
            id: result.id ?? '',
            version: result.version ?? '',
            cases: result.cases ?? 0,
          })}
        </Callout>
      )}

      <p className="text-[12px] leading-relaxed text-muted-foreground">{t('versionNote')}</p>

      <Button type="button" onClick={onImport} disabled={busy || !selected}>
        {busy ? t('importing') : t('addToWorkspace')}
      </Button>
    </div>
  )
}
