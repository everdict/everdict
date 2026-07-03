'use client'

import { useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

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
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const entries: Entry[] = useMemo(
    () => [
      ...benchmarks.map((b) => ({
        value: `catalog:${b.id}`,
        kind: 'catalog' as const,
        id: b.id,
        label: `${b.id} · ${b.category}${b.gated ? ' · gated' : ''}${b.source === 'jsonl' ? ' · 파일 업로드' : ''}`,
        source: b.source,
        gated: b.gated,
        description: b.description,
      })),
      ...recipes.map((r) => ({
        value: `recipe:${r.id}`,
        kind: 'recipe' as const,
        id: r.id,
        label: `${r.id} · 레시피${r.owner === '_shared' ? '(shared)' : ''}`,
      })),
    ],
    [benchmarks, recipes]
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
      setResult({ ok: false, error: '이 벤치마크는 jsonl 파일 내용이 필요합니다.' })
      return
    }
    if (text.trim()) body.text = text
    const res = await importBenchmarkAction(body)
    setBusy(false)
    setResult(res)
    if (res.ok) router.push(`/${workspace}/datasets`)
  }

  if (entries.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">사용 가능한 벤치마크/레시피가 없습니다.</p>
    )
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-1.5">
        <Label htmlFor="benchmark">벤치마크 / 레시피</Label>
        {/* optgroup 대응 — 카탈로그/레시피 구분은 우측 hint 로(그룹 헤더 없는 flat 리스트) */}
        <Combobox
          id="benchmark"
          value={sel}
          onChange={setSel}
          options={entries.map((e) => ({
            value: e.value,
            label: e.label,
            hint: e.kind === 'catalog' ? '카탈로그' : '내 레시피',
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
          gated 벤치마크입니다 — 워크스페이스 시크릿 <code>HF_TOKEN</code> 이 있어야 인출됩니다.
        </Callout>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="datasetId">데이터셋 id (선택)</Label>
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
          <Label htmlFor="limit">최대 케이스 수 (선택)</Label>
          <Input
            id="limit"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="예: 50 (HF 소스일 때만 의미)"
            inputMode="numeric"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="text">
          jsonl 내용 {catalogJsonl ? '(필수)' : '(jsonl 소스 레시피일 때만)'}
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

      {result && !result.ok && <Callout tone="danger">인입 실패: {result.error}</Callout>}
      {result?.ok && (
        <Callout tone="info">
          ✓ {result.id}@{result.version} · 케이스 {result.cases}건 등록됨
        </Callout>
      )}

      <p className="text-[12px] leading-relaxed text-muted-foreground">
        버전은 불변입니다 — 같은 (id, version)을 다른 내용으로 다시 인입하면 409 로 거부됩니다.
      </p>

      <Button type="button" onClick={onImport} disabled={busy || !selected}>
        {busy ? '인입 중…' : '워크스페이스에 추가'}
      </Button>
    </div>
  )
}
