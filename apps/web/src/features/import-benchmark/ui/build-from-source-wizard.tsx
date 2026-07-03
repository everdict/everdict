'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Eye, Heart, Loader2, Lock, Search, Sparkles } from 'lucide-react'

import { versionsForId } from '@/shared/lib/semver'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { VersionField } from '@/shared/ui/version-field'

import {
  hfSplitsAction,
  importBenchmarkAction,
  previewSourceAction,
  searchHfDatasetsAction,
  type HfDatasetHit,
  type HfSplit,
  type ImportBenchmarkResult,
  type PreviewSourceResult,
} from '../api/import-benchmark'

type SourceKind = 'huggingface' | 'jsonl'
type Category = 'qa' | 'browser' | 'coding' | 'tool'
// 케이스가 실행될 환경 — 매핑이 정하는 env 종류. browser(startUrl) | prompt(QA, 무환경) | repo(git clone) | os-use(데스크탑).
type EnvKind = 'browser' | 'prompt' | 'repo' | 'os-use'

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

const splitKey = (s: HfSplit) => `${s.config} / ${s.split}`

// "소스에서 만들기" 위저드: HF 는 검색→선택→config/split 드롭다운(raw id 입력 회피), jsonl 은 붙여넣기.
// 그 뒤 미리보기로 필드를 감지하고 드롭다운 매핑 → 한 번에 데이터셋 생성(인라인 spec, 레시피 등록 생략).
export function BuildFromSourceWizard({
  existingDatasets = [],
}: {
  existingDatasets?: { id: string; versions: string[] }[]
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [sourceKind, setSourceKind] = useState<SourceKind>('huggingface')

  // HF 검색/선택
  const [query, setQuery] = useState('')
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState<string | undefined>(undefined)
  const [hits, setHits] = useState<HfDatasetHit[]>([])
  const [hfDataset, setHfDataset] = useState('') // 선택된 데이터셋 id
  const [hfGated, setHfGated] = useState(false)
  const [splits, setSplits] = useState<HfSplit[]>([])
  const [splitSel, setSplitSel] = useState('') // splitKey
  const [splitsNote, setSplitsNote] = useState<string | undefined>(undefined)

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
  // env 종류 + repo/이미지/placement 매핑(first-party 카탈로그와 동등한 표현력).
  const [envKind, setEnvKind] = useState<EnvKind>('browser')
  const [gitField, setGitField] = useState('')
  const [refField, setRefField] = useState('')
  const [image, setImage] = useState('')
  const [placement, setPlacement] = useState('')

  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | undefined>(undefined)
  const [createBusy, setCreateBusy] = useState(false)
  const [createResult, setCreateResult] = useState<ImportBenchmarkResult | undefined>(undefined)

  function resetPreview() {
    setFields([])
    setRows([])
    setPreviewError(undefined)
    setCreateResult(undefined)
  }

  async function onSearch() {
    if (!query.trim()) return
    setSearchBusy(true)
    setSearchError(undefined)
    const r = await searchHfDatasetsAction(query.trim(), 20)
    setSearchBusy(false)
    if (!r.ok || !r.hits) {
      setHits([])
      setSearchError(r.error ?? '검색 실패')
      return
    }
    setHits(r.hits)
  }

  async function selectHit(hit: HfDatasetHit) {
    setHfDataset(hit.id)
    setHfGated(hit.gated)
    setHits([])
    setQuery(hit.id)
    setSplits([])
    setSplitSel('')
    setSplitsNote(undefined)
    resetPreview()
    if (!datasetId) setDatasetId(slug(hit.id))
    // config/split 후보 인출 → 드롭다운.
    const r = await hfSplitsAction(hit.id)
    if (r.ok && r.splits && r.splits.length > 0) {
      setSplits(r.splits)
      // test 우선, 없으면 첫 번째.
      const pick = r.splits.find((s) => s.split === 'test') ?? r.splits[0]
      if (pick) setSplitSel(splitKey(pick))
    } else {
      setSplitsNote('config/split 정보를 가져오지 못했습니다 — 기본값(train)으로 미리보기됩니다.')
    }
  }

  const selectedSplit = splits.find((s) => splitKey(s) === splitSel)

  function buildSource(): Record<string, unknown> {
    if (sourceKind !== 'huggingface') return { kind: 'jsonl' }
    return {
      kind: 'huggingface',
      dataset: hfDataset,
      ...(selectedSplit?.config ? { config: selectedSplit.config } : {}),
      ...(selectedSplit?.split ? { split: selectedSplit.split } : {}),
    }
  }

  async function onPreview() {
    setPreviewBusy(true)
    resetPreview()
    const body: Record<string, unknown> = { source: buildSource(), limit: 5 }
    if (sourceKind === 'jsonl') body.text = jsonlText
    const r: PreviewSourceResult = await previewSourceAction(body)
    setPreviewBusy(false)
    if (!r.ok || !r.fields) {
      setPreviewError(r.error ?? '미리보기 실패')
      return
    }
    setFields(r.fields)
    setRows(r.rows ?? [])
    const ans = guess(r.fields, [/answer|label|solution|target|gold|output|^a$/i])
    const url = guess(r.fields, [/start.?url|^url$|web$|site/i])
    const git = guess(r.fields, [/repo|clone.?url|git.?url|^git$/i])
    setIdField(guess(r.fields, [/^id$/i, /(_|^)id$/i]) || r.fields[0] || '')
    setTaskField(guess(r.fields, [/task|question|ques|query|prompt|instruction|goal|intent|^q$/i]))
    setAnswerField(ans)
    setStartUrlField(url)
    setGitField(git)
    setRefField(guess(r.fields, [/^ref$|base.?commit|commit|revision|sha/i]))
    // env 기본값 추측: git 필드 있으면 repo, URL 있으면 browser, 정답 있으면 prompt(QA), 아니면 browser.
    setEnvKind(git ? 'repo' : url ? 'browser' : ans ? 'prompt' : 'browser')
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
        // env 종류별 매핑 — first-party 카탈로그와 동등한 표현력(prompt/repo/os-use/browser).
        ...(envKind === 'browser' && startUrlField ? { startUrlField } : {}),
        ...(envKind === 'prompt' ? { promptEnv: true } : {}),
        ...(envKind === 'os-use' ? { osUseEnv: true } : {}),
        ...(envKind === 'repo' && gitField ? { gitField, ...(refField ? { refField } : {}) } : {}),
        ...(image.trim() ? { image: image.trim() } : {}),
        ...(placement.trim() ? { placement: placement.trim() } : {}),
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
      router.push(`/${workspace}/datasets`)
      router.refresh()
    }
  }

  const previewed = fields.length > 0
  const canPreview =
    sourceKind === 'huggingface' ? hfDataset.length > 0 : jsonlText.trim().length > 0

  return (
    <div className="max-w-2xl space-y-6">
      {/* 1. 소스 */}
      <section className="space-y-3">
        <div className="text-[11px] font-[510] uppercase tracking-wide text-faint">1 · 소스</div>
        <div className="inline-flex rounded-lg border bg-secondary/40 p-0.5">
          {(['huggingface', 'jsonl'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setSourceKind(k)}
              className={cn(
                'rounded-md px-3 py-1 text-[13px] transition-colors',
                sourceKind === k
                  ? 'bg-card font-[510] text-foreground shadow-raise'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {k === 'huggingface' ? 'HuggingFace' : 'JSONL 붙여넣기'}
            </button>
          ))}
        </div>

        {sourceKind === 'huggingface' ? (
          <div className="space-y-3">
            {/* 검색 */}
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    onSearch()
                  }
                }}
                placeholder="데이터셋 검색 (예: gsm8k, webvoyager, mmlu …)"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={onSearch}
                disabled={searchBusy || !query.trim()}
                className="shrink-0 gap-1.5"
              >
                {searchBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Search className="size-4" />
                )}
                검색
              </Button>
            </div>
            {searchError && (
              <Callout
                tone="warning"
                hint="HuggingFace 에 접속할 수 없으면 위 'JSONL 붙여넣기'로 전환해 데이터를 직접 넣어 추가할 수 있습니다."
              >
                {searchError}
              </Callout>
            )}

            {/* 검색 결과 */}
            {hits.length > 0 && (
              <div className="max-h-64 divide-y divide-border/60 overflow-auto rounded-lg border bg-card shadow-raise">
                {hits.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => selectHit(h)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-elevated"
                  >
                    <span className="truncate font-mono text-[12px]">{h.id}</span>
                    <span className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
                      {h.gated && (
                        <span className="inline-flex items-center gap-1 text-[var(--color-warning)]">
                          <Lock className="size-3" /> gated
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1">
                        <Heart className="size-3" /> {h.likes}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* 선택됨 + split */}
            {hfDataset && (
              <div className="space-y-2 rounded-lg border bg-card p-3 shadow-raise">
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="text-muted-foreground">선택됨:</span>
                  <code className="font-mono text-foreground">{hfDataset}</code>
                  {hfGated && (
                    <span className="inline-flex items-center gap-1 text-[12px] text-[var(--color-warning)]">
                      <Lock className="size-3" /> gated · HF_TOKEN 시크릿 필요
                    </span>
                  )}
                </div>
                {splits.length > 0 ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="split">config / split</Label>
                    <Combobox
                      id="split"
                      value={splitSel}
                      onChange={setSplitSel}
                      options={splits.map((s) => ({
                        value: splitKey(s),
                        label: `${s.config} / ${s.split}`,
                      }))}
                      className="w-full"
                    />
                  </div>
                ) : (
                  splitsNote && <p className="text-xs text-muted-foreground">{splitsNote}</p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="jsonl">JSONL (한 줄 = 한 JSON 객체)</Label>
            <Textarea
              id="jsonl"
              className="min-h-40 text-[12px]"
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
        {previewError && (
          <Callout
            tone="warning"
            {...(sourceKind === 'huggingface'
              ? {
                  hint: 'HuggingFace 에 접속할 수 없으면 JSONL 붙여넣기로 데이터를 직접 넣어 추가할 수 있습니다.',
                }
              : {})}
          >
            {previewError}
          </Callout>
        )}
        {previewed && (
          <Callout tone="muted">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-foreground">감지된 필드:</span>
              {fields.map((f) => (
                <code
                  key={f}
                  className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border"
                >
                  {f}
                </code>
              ))}
            </div>
            {rows[0] && (
              <pre className="mt-2 max-h-32 overflow-auto rounded-lg border bg-card p-2 font-mono text-[11px] leading-relaxed">
                {JSON.stringify(rows[0], null, 2)}
              </pre>
            )}
          </Callout>
        )}
      </section>

      {/* 2. 매핑 (미리보기 후) */}
      {previewed && (
        <section className="space-y-3">
          <div className="flex items-center gap-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
            2 · 매핑 <Sparkles className="size-3.5 text-primary" />
            <span className="normal-case tracking-normal text-muted-foreground/70">
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
            <div className="space-y-1.5">
              <Label htmlFor="envKind">실행 환경</Label>
              <Combobox
                id="envKind"
                value={envKind}
                onChange={(v) => setEnvKind(v as EnvKind)}
                options={[
                  { value: 'browser', label: 'browser (웹, startUrl)' },
                  { value: 'prompt', label: 'prompt (QA, 무환경)' },
                  { value: 'repo', label: 'repo (git clone · 코딩)' },
                  { value: 'os-use', label: 'os-use (데스크탑)' },
                ]}
                className="w-full"
              />
            </div>
          </div>
          {/* env 종류별 추가 필드 */}
          {envKind === 'browser' && (
            <MapField
              label="start URL 필드 (선택 · browser)"
              value={startUrlField}
              onChange={setStartUrlField}
              fields={fields}
              optional
            />
          )}
          {envKind === 'repo' && (
            <div className="grid grid-cols-2 gap-3">
              <MapField
                label="git repo 필드 (필수 · repo)"
                value={gitField}
                onChange={setGitField}
                fields={fields}
              />
              <MapField
                label="ref/commit 필드 (선택)"
                value={refField}
                onChange={setRefField}
                fields={fields}
                optional
              />
            </div>
          )}
          {envKind === 'os-use' && (
            <p className="text-[12px] text-muted-foreground">
              os-use 는 데스크탑 이미지에서 실행됩니다 — 아래 3단계에서 케이스 이미지를
              지정하세요(Xvfb 등 상세 setup 은 레시피/번들 JSON 으로).
            </p>
          )}
        </section>
      )}

      {/* 3. 데이터셋 메타 + 생성 (미리보기 후) */}
      {previewed && (
        <section className="space-y-3">
          <div className="text-[11px] font-[510] uppercase tracking-wide text-faint">
            3 · 데이터셋
          </div>
          <div className="grid grid-cols-2 gap-3">
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
              <Label htmlFor="cat">category</Label>
              <Combobox
                id="cat"
                value={category}
                onChange={(v) => setCategory(v as Category)}
                options={[
                  { value: 'qa' },
                  { value: 'browser' },
                  { value: 'coding' },
                  { value: 'tool' },
                ]}
                className="w-full"
              />
            </div>
          </div>
          <VersionField
            existing={versionsForId(existingDatasets, datasetId)}
            value={version}
            onChange={setVersion}
          />
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
          {/* 케이스 컴퓨트 이미지 / placement(런타임 라우팅) — 모든 케이스 공통(선택). os-use/prebuilt 벤치마크용. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="img">케이스 이미지 (선택)</Label>
              <Input
                id="img"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="예: my-osworld:latest"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="place">placement target (선택)</Label>
              <Input
                id="place"
                value={placement}
                onChange={(e) => setPlacement(e.target.value)}
                placeholder="예: docker"
              />
            </div>
          </div>

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
          <p className="text-[12px] leading-relaxed text-muted-foreground">
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
      {/* optional=빈 값 '(없음)' 옵션 노출, 필수=빈 값이면 placeholder 로 선택 유도(기존 native 동작 유지) */}
      <Combobox
        value={value}
        onChange={onChange}
        options={[
          ...(optional ? [{ value: '', label: '(없음)' }] : []),
          ...fields.map((f) => ({ value: f })),
        ]}
        placeholder="— 선택 —"
        className="w-full"
        aria-label={label}
      />
    </div>
  )
}
