'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, Loader2, Sparkles } from 'lucide-react'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label, Select, Textarea } from '@/shared/ui/input'

import {
  importBenchmarkAction,
  previewSourceAction,
  type ImportBenchmarkResult,
  type PreviewSourceResult,
} from '../api/import-benchmark'

type SourceKind = 'huggingface' | 'jsonl'
type Category = 'qa' | 'browser' | 'coding' | 'tool'

// 감지된 필드명에서 매핑을 추측 — 사용자가 스키마를 몰라도 합리적 기본값을 채워준다.
function guess(fields: string[], patterns: RegExp[]): string {
  for (const p of patterns) {
    const hit = fields.find((f) => p.test(f))
    if (hit) return hit
  }
  return ''
}

function slug(s: string): string {
  return (
    s
      .split('/')
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || ''
  )
}

// "소스에서 만들기" 위저드: 소스 입력 → 미리보기(필드 자동감지) → 드롭다운 매핑 → 한 번에 데이터셋 생성.
// 레시피를 손으로 JSON 작성하던 마찰을 없앤다(인라인 spec 으로 등록 단계 생략).
export function BuildFromSourceWizard() {
  const router = useRouter()
  const [sourceKind, setSourceKind] = useState<SourceKind>('huggingface')
  const [hfDataset, setHfDataset] = useState('')
  const [hfConfig, setHfConfig] = useState('')
  const [hfSplit, setHfSplit] = useState('')
  const [jsonlText, setJsonlText] = useState('')

  const [datasetId, setDatasetId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [category, setCategory] = useState<Category>('qa')
  const [limit, setLimit] = useState('')

  const [fields, setFields] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [idField, setIdField] = useState('')
  const [taskField, setTaskField] = useState('')
  const [answerField, setAnswerField] = useState('')
  const [startUrlField, setStartUrlField] = useState('')

  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | undefined>(undefined)
  const [createBusy, setCreateBusy] = useState(false)
  const [createResult, setCreateResult] = useState<ImportBenchmarkResult | undefined>(undefined)

  function buildSource(): Record<string, unknown> {
    return sourceKind === 'huggingface'
      ? {
          kind: 'huggingface',
          dataset: hfDataset.trim(),
          ...(hfConfig.trim() ? { config: hfConfig.trim() } : {}),
          ...(hfSplit.trim() ? { split: hfSplit.trim() } : {}),
        }
      : { kind: 'jsonl' }
  }

  async function onPreview() {
    setPreviewBusy(true)
    setPreviewError(undefined)
    setCreateResult(undefined)
    const body: Record<string, unknown> = { source: buildSource(), limit: 5 }
    if (sourceKind === 'jsonl') body.text = jsonlText
    const r: PreviewSourceResult = await previewSourceAction(body)
    setPreviewBusy(false)
    if (!r.ok || !r.fields) {
      setFields([])
      setRows([])
      setPreviewError(r.error ?? '미리보기 실패')
      return
    }
    setFields(r.fields)
    setRows(r.rows ?? [])
    // 매핑 자동 추측(사용자가 바꿀 수 있음).
    setIdField(guess(r.fields, [/^id$/i, /(_|^)id$/i]) || r.fields[0] || '')
    setTaskField(guess(r.fields, [/task|question|ques|query|prompt|instruction|goal|intent|^q$/i]))
    setAnswerField(guess(r.fields, [/answer|label|solution|target|gold|output|^a$/i]))
    setStartUrlField(guess(r.fields, [/start.?url|^url$|web$|site/i]))
    if (!datasetId && sourceKind === 'huggingface') setDatasetId(slug(hfDataset))
  }

  async function onCreate() {
    if (!idField || !taskField) return
    setCreateBusy(true)
    setCreateResult(undefined)
    const id = datasetId.trim() || (sourceKind === 'huggingface' ? slug(hfDataset) : 'benchmark')
    const spec: Record<string, unknown> = {
      id,
      version,
      category,
      source: buildSource(),
      mapping: {
        idField,
        taskField,
        ...(answerField ? { answerField } : {}),
        ...(startUrlField ? { startUrlField } : {}),
      },
    }
    const body: Record<string, unknown> = { spec, id, version }
    if (sourceKind === 'jsonl') body.text = jsonlText
    if (sourceKind === 'huggingface' && limit && Number.isFinite(Number(limit)))
      body.limit = Number(limit)
    const r = await importBenchmarkAction(body)
    setCreateBusy(false)
    setCreateResult(r)
    if (r.ok) {
      router.push('/dashboard/datasets')
      router.refresh()
    }
  }

  const previewed = fields.length > 0
  const canPreview =
    sourceKind === 'huggingface' ? hfDataset.trim().length > 0 : jsonlText.trim().length > 0

  return (
    <div className="max-w-2xl space-y-6">
      {/* 1. 소스 */}
      <section className="space-y-3">
        <div className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          1 · 소스
        </div>
        <div className="inline-flex rounded-lg border border-border p-1">
          {(['huggingface', 'jsonl'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setSourceKind(k)}
              className={
                sourceKind === k
                  ? 'rounded-md bg-secondary px-3 py-1 text-sm font-medium text-foreground'
                  : 'rounded-md px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground'
              }
            >
              {k === 'huggingface' ? 'HuggingFace' : 'JSONL 붙여넣기'}
            </button>
          ))}
        </div>

        {sourceKind === 'huggingface' ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="hf">HF 데이터셋</Label>
              <Input
                id="hf"
                value={hfDataset}
                onChange={(e) => setHfDataset(e.target.value)}
                placeholder="예: openai/gsm8k"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cfg">config (선택)</Label>
              <Input
                id="cfg"
                value={hfConfig}
                onChange={(e) => setHfConfig(e.target.value)}
                placeholder="main"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="split">split (선택)</Label>
              <Input
                id="split"
                value={hfSplit}
                onChange={(e) => setHfSplit(e.target.value)}
                placeholder="test"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="jsonl">JSONL (한 줄 = 한 JSON 객체)</Label>
            <Textarea
              id="jsonl"
              className="min-h-40 font-mono text-xs"
              value={jsonlText}
              onChange={(e) => setJsonlText(e.target.value)}
              spellCheck={false}
              placeholder='{"id":"ex-0","question":"...","answer":"..."}'
            />
          </div>
        )}

        <Button
          type="button"
          variant="secondary"
          onClick={onPreview}
          disabled={previewBusy || !canPreview}
          className="gap-1.5"
        >
          {previewBusy ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
          미리보기 (필드 감지)
        </Button>
        {previewError && <Callout tone="danger">{previewError}</Callout>}
        {previewed && (
          <Callout tone="muted">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-foreground">감지된 필드:</span>
              {fields.map((f) => (
                <code
                  key={f}
                  className="rounded-md border border-border bg-card px-1.5 py-0.5 text-xs"
                >
                  {f}
                </code>
              ))}
            </div>
            {rows[0] && (
              <pre className="mt-2 max-h-32 overflow-auto rounded-lg border border-border bg-card p-2 text-[11px] leading-relaxed">
                {JSON.stringify(rows[0], null, 2)}
              </pre>
            )}
          </Callout>
        )}
      </section>

      {/* 2. 매핑 (미리보기 후) */}
      {previewed && (
        <section className="space-y-3">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
            2 · 매핑 <Sparkles className="size-3.5 text-primary" />
            <span className="font-normal normal-case tracking-normal text-muted-foreground/70">
              자동 추측됨 — 필요하면 바꾸세요
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <MapField
              label="task 필드 (필수)"
              value={taskField}
              onChange={setTaskField}
              fields={fields}
            />
            <MapField
              label="id 필드 (필수)"
              value={idField}
              onChange={setIdField}
              fields={fields}
            />
            <MapField
              label="answer 필드 (선택)"
              value={answerField}
              onChange={setAnswerField}
              fields={fields}
              optional
            />
            <MapField
              label="start URL 필드 (선택 · browser)"
              value={startUrlField}
              onChange={setStartUrlField}
              fields={fields}
              optional
            />
          </div>
        </section>
      )}

      {/* 3. 데이터셋 메타 + 생성 (미리보기 후) */}
      {previewed && (
        <section className="space-y-3">
          <div className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
            3 · 데이터셋
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="dsid">id</Label>
              <Input
                id="dsid"
                value={datasetId}
                onChange={(e) => setDatasetId(e.target.value)}
                placeholder="my-bench"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ver">version</Label>
              <Input
                id="ver"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cat">category</Label>
              <Select
                id="cat"
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
              >
                <option value="qa">qa</option>
                <option value="browser">browser</option>
                <option value="coding">coding</option>
                <option value="tool">tool</option>
              </Select>
            </div>
          </div>
          {sourceKind === 'huggingface' && (
            <div className="space-y-1.5">
              <Label htmlFor="lim">최대 케이스 수 (선택)</Label>
              <Input
                id="lim"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder="예: 50"
                inputMode="numeric"
              />
            </div>
          )}

          {createResult && !createResult.ok && (
            <Callout tone="danger">생성 실패: {createResult.error}</Callout>
          )}

          <Button
            type="button"
            onClick={onCreate}
            disabled={createBusy || !idField || !taskField}
            className="gap-1.5"
          >
            {createBusy ? <Loader2 className="size-4 animate-spin" /> : null}
            벤치마크 만들기 → 데이터셋
          </Button>
          <p className="text-xs text-muted-foreground">
            버전은 불변입니다 — 같은 (id, version)을 다른 내용으로 다시 만들면 409.
          </p>
        </section>
      )}
    </div>
  )
}

function MapField({
  label,
  value,
  onChange,
  fields,
  optional,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  fields: string[]
  optional?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {optional && <option value="">(없음)</option>}
        {!optional && value === '' && <option value="">— 선택 —</option>}
        {fields.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </Select>
    </div>
  )
}
