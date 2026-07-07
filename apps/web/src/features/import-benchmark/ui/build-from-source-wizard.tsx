'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { ChevronRight, Eye, Heart, Loader2, Lock, Search, Settings2, Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { versionsForId } from '@/shared/lib/semver'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'
import { VersionField } from '@/shared/ui/version-field'

import {
  hfFilesAction,
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

// 필드→역할 시각화. task/id/answer 는 표 머리글 클릭으로 지정(주요 색), 나머지(git/ref/url)는 env 섹션에서 지정(연한 배지).
const ROLE_META: Record<string, { label: string; color: string }> = {
  task: { label: 'task', color: '#5e6ad2' },
  id: { label: 'id', color: '#3fb6c9' },
  answer: { label: 'answer', color: '#46b96a' },
  git: { label: 'git', color: '#8b93e8' },
  ref: { label: 'ref', color: '#8b93e8' },
  url: { label: 'url', color: '#8b93e8' },
}
const cellText = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

// 실행 환경 → 데이터셋 category(표시·필터용 메타). 유저가 고르지 않고 env 에서 파생한다.
const ENV_TO_CATEGORY: Record<EnvKind, Category> = {
  prompt: 'qa',
  browser: 'browser',
  repo: 'coding',
  'os-use': 'tool',
}

// 매핑 상태 → "이 벤치마크가 실제로 어떻게 실행/채점되는지"를 한 문장으로 서술한다(선택이 아니라 결과 확인).
// tone=warn 이면 env 설정이 불완전(고급 설정에서 보완 필요). 문장은 언어별 어순이 달라 t.rich 로 조립.
function describeRun(
  a: {
    envKind: EnvKind
    taskField: string
    answerField: string
    startUrlField: string
    gitField: string
    hasImage: boolean
  },
  t: ReturnType<typeof useTranslations>
): { title: string; body: ReactNode; tone: 'ok' | 'warn' } {
  const codeTag = (chunks: ReactNode) => (
    <code className="rounded bg-secondary/70 px-1 font-mono text-[11px] text-foreground">
      {chunks}
    </code>
  )
  const taskNode = a.taskField ? (
    <code className="rounded bg-secondary/70 px-1 font-mono text-[11px] text-foreground">
      {a.taskField}
    </code>
  ) : (
    <span className="text-[var(--color-warning)]">{t('taskUnset')}</span>
  )
  const taskTag = () => taskNode
  const grade = a.answerField
    ? t.rich('gradeWithAnswer', { field: a.answerField, code: codeTag })
    : t('gradeNoAnswer')
  switch (a.envKind) {
    case 'prompt':
      return {
        title: t('runPromptTitle'),
        body: (
          <>
            {t.rich('promptBody', { task: taskTag })}
            {grade}
          </>
        ),
        tone: 'ok',
      }
    case 'browser':
      return {
        title: t('runBrowserTitle'),
        body: (
          <>
            {a.startUrlField
              ? t.rich('browserBodyWithUrl', {
                  url: a.startUrlField,
                  task: taskTag,
                  code: codeTag,
                })
              : t.rich('browserBodyNoUrl', { task: taskTag })}
            {a.answerField ? grade : null}
          </>
        ),
        tone: 'ok',
      }
    case 'repo':
      return a.gitField
        ? {
            title: t('runRepoTitle'),
            body: t.rich('repoBody', { git: a.gitField, task: taskTag, code: codeTag }),
            tone: 'ok',
          }
        : {
            title: t('runRepoTitle'),
            body: t('repoBodyNoGit'),
            tone: 'warn',
          }
    case 'os-use':
      return a.hasImage
        ? {
            title: t('runOsUseTitle'),
            body: t.rich('osUseBody', { task: taskTag }),
            tone: 'ok',
          }
        : {
            title: t('runOsUseTitle'),
            body: t('osUseBodyNoImage'),
            tone: 'warn',
          }
  }
}

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
  hfTokenScope,
}: {
  existingDatasets?: { id: string; versions: string[] }[]
  hfTokenScope?: 'user' | 'workspace' // 사용 가능한 HF_TOKEN 의 스코프 — gated 표시를 상태 인지형으로
}) {
  const t = useTranslations('importBenchmark')
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
  // 뷰어(datasets-server) 미서빙 데이터셋 폴백 — repo 데이터 파일을 골라 직접 인출.
  const [files, setFiles] = useState<string[]>([])
  const [fileSel, setFileSel] = useState('')

  const [jsonlText, setJsonlText] = useState('')

  const [datasetId, setDatasetId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [advanced, setAdvanced] = useState(false) // 고급(작성자) 설정 — 실행 환경/템플릿/이미지/placement

  const [fields, setFields] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [idField, setIdField] = useState('')
  const [taskField, setTaskField] = useState('')
  const [taskTemplate, setTaskTemplate] = useState('')
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
      setSearchError(r.error ?? t('searchFailed'))
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
    setFiles([])
    setFileSel('')
    resetPreview()
    if (!datasetId) setDatasetId(slug(hit.id))
    // config/split 후보 인출 → 드롭다운.
    const r = await hfSplitsAction(hit.id)
    if (r.ok && r.splits && r.splits.length > 0) {
      setSplits(r.splits)
      // test 우선, 없으면 첫 번째.
      const pick = r.splits.find((s) => s.split === 'test') ?? r.splits[0]
      if (pick) setSplitSel(splitKey(pick))
      return
    }
    // 뷰어가 이 데이터셋을 서빙하지 않음(officeqa 류) → repo 데이터 파일 직접 인출 폴백.
    const fr = await hfFilesAction(hit.id)
    if (fr.ok && fr.files && fr.files.length > 0) {
      setFiles(fr.files)
      const first = fr.files[0]
      if (first) setFileSel(first)
      setSplitsNote(undefined)
    } else {
      setSplitsNote(t('splitsNote'))
    }
  }

  const selectedSplit = splits.find((s) => splitKey(s) === splitSel)

  function buildSource(): Record<string, unknown> {
    if (sourceKind !== 'huggingface') return { kind: 'jsonl' }
    // 파일 폴백 모드(뷰어 미서빙)면 file 로 직접 인출 — config/split 은 뷰어 전용이라 생략.
    if (fileSel) return { kind: 'huggingface', dataset: hfDataset, file: fileSel }
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
      setPreviewError(r.error ?? t('previewFailed'))
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

  // 시스템 관리 버전 — 첫 인입이면 1.0.0(필드 숨김), 같은 id 재인입이면 VersionField 가 다음 버전을 계산.
  const existingVersions = versionsForId(existingDatasets, datasetId)
  const effectiveVersion = existingVersions.length > 0 ? version : '1.0.0'

  async function onCreate() {
    if (!idField || !taskField) return
    setCreateBusy(true)
    setCreateResult(undefined)
    const id = datasetId.trim() || (sourceKind === 'huggingface' ? slug(hfDataset) : 'benchmark')
    const spec: Record<string, unknown> = {
      id,
      version: effectiveVersion,
      category: ENV_TO_CATEGORY[envKind], // env 에서 파생(유저가 고르지 않음)
      source: buildSource(),
      mapping: {
        idField,
        taskField,
        ...(taskTemplate.trim() ? { taskTemplate } : {}),
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
    const body: Record<string, unknown> = { spec, id, version: effectiveVersion }
    if (sourceKind === 'jsonl') body.text = jsonlText
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
  const run = describeRun(
    {
      envKind,
      taskField,
      answerField,
      startUrlField,
      gitField,
      hasImage: image.trim().length > 0,
    },
    t
  )

  // 현재 매핑 상태에서 필드의 역할을 역산(표 머리글/셀 강조에 사용).
  const roleOf = (f: string): string =>
    f === taskField
      ? 'task'
      : f === idField
        ? 'id'
        : f === answerField
          ? 'answer'
          : f === gitField
            ? 'git'
            : f === refField
              ? 'ref'
              : f === startUrlField
                ? 'url'
                : ''
  // 표 머리글 클릭 → task→id→answer→없음 순환. 단일 상태값이라 역할은 자동으로 유일해진다(같은 역할은 한 열만).
  function cycleRole(f: string) {
    const order = ['task', 'id', 'answer', ''] as const
    const cur = (['task', 'id', 'answer'] as string[]).includes(roleOf(f)) ? roleOf(f) : ''
    const next = order[(order.indexOf(cur as (typeof order)[number]) + 1) % order.length]
    // 이 필드를 기존 모든 역할에서 해제한 뒤 새 역할 지정.
    if (idField === f) setIdField('')
    if (taskField === f) setTaskField('')
    if (answerField === f) setAnswerField('')
    if (gitField === f) setGitField('')
    if (refField === f) setRefField('')
    if (startUrlField === f) setStartUrlField('')
    if (next === 'task') setTaskField(f)
    else if (next === 'id') setIdField(f)
    else if (next === 'answer') setAnswerField(f)
  }
  // 매핑 컨트롤 아래에 보여줄 샘플 값(첫 행).
  const sampleOf = (f: string): string => (f && rows[0] ? cellText(rows[0][f]) : '')

  return (
    <div className="space-y-6">
      {/* 1. 소스 */}
      <section className="space-y-3">
        <div className="text-[11px] font-[510] uppercase tracking-wide text-faint">
          {t('step1Source')}
        </div>
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
              {k === 'huggingface' ? 'HuggingFace' : t('pasteJsonl')}
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
                placeholder={t('hfSearchPlaceholder')}
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
                {t('search')}
              </Button>
            </div>
            {searchError && (
              <Callout tone="warning" hint={t('hfConnectHint')}>
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
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="text-muted-foreground">{t('selected')}</span>
                  <code className="font-mono text-foreground">{hfDataset}</code>
                  {hfGated &&
                    (hfTokenScope ? (
                      <span className="inline-flex items-center gap-1 text-[12px] text-[var(--color-success)]">
                        <Lock className="size-3" /> gated ·{' '}
                        {t('gatedTokenUsing', {
                          scope: hfTokenScope === 'user' ? t('scopeMine') : t('scopeWorkspace'),
                        })}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[12px] text-[var(--color-warning)]">
                        <Lock className="size-3" /> gated · {t('gatedTokenNeeded')}
                        <Link
                          href={`/${workspace}/account?tab=secrets`}
                          className="font-[510] text-primary underline-offset-2 hover:underline"
                        >
                          {t('registerInAccount')}
                        </Link>
                      </span>
                    ))}
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
                ) : files.length > 0 ? (
                  // 뷰어 미서빙 → repo 데이터 파일 직접 선택(csv/jsonl/json).
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1">
                      <Label htmlFor="hfFile">{t('dataFile')}</Label>
                      <InfoTip content={t('dataFileTip')} />
                    </div>
                    <Combobox
                      id="hfFile"
                      value={fileSel}
                      onChange={setFileSel}
                      options={files.map((f) => ({ value: f }))}
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
            <Label htmlFor="jsonl">{t('jsonlLabel')}</Label>
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
          {t('preview')}
        </Button>
        {previewError && (
          <Callout
            tone="warning"
            {...(sourceKind === 'huggingface'
              ? {
                  // gated + 토큰 미보유가 가장 흔한 실패 — 셀프서비스 경로(계정 시크릿)를 바로 안내.
                  hint: hfGated && !hfTokenScope ? t('previewHintGated') : t('hfConnectHint'),
                }
              : {})}
          >
            {previewError}
          </Callout>
        )}
        {previewed && (
          <div className="space-y-2">
            <p className="text-[12.5px] text-muted-foreground">
              {t.rich('fieldsFound', {
                count: fields.length,
                b: (chunks) => <b className="text-foreground">{chunks}</b>,
              })}
            </p>
            <div className="overflow-x-auto rounded-lg border bg-card shadow-raise">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr>
                    {fields.map((f) => {
                      const meta = ROLE_META[roleOf(f)]
                      return (
                        <th
                          key={f}
                          className="border-b border-border bg-elevated p-0 text-left align-top"
                        >
                          <button
                            type="button"
                            onClick={() => cycleRole(f)}
                            title={t('cycleRoleTip')}
                            className="w-full cursor-pointer border-t-2 px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                            style={{ borderTopColor: meta ? meta.color : 'transparent' }}
                          >
                            <span className="mb-1.5 block font-mono text-[11px] text-muted-foreground">
                              {f}
                            </span>
                            {meta ? (
                              <span
                                className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-[590]"
                                style={{
                                  color: meta.color,
                                  background: `${meta.color}1f`,
                                  boxShadow: `inset 0 0 0 1px ${meta.color}55`,
                                }}
                              >
                                <span
                                  className="size-[7px] rounded-[2px]"
                                  style={{ background: meta.color }}
                                />
                                {meta.label}
                              </span>
                            ) : (
                              <span className="text-[11px] text-faint">{t('noRole')}</span>
                            )}
                          </button>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 4).map((row, i) => (
                    <tr key={i}>
                      {fields.map((f) => (
                        <td
                          key={f}
                          className={cn(
                            'max-w-[280px] truncate border-b border-border/60 px-3 py-2 align-top font-mono text-[11px]',
                            roleOf(f) ? 'text-foreground' : 'text-muted-foreground'
                          )}
                          title={cellText(row[f])}
                        >
                          {cellText(row[f])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* 2. 매핑 (미리보기 후) — 역할 3개만. 나머지(실행 환경/템플릿/이미지)는 자동 추론 + 고급 설정. */}
      {previewed && (
        <section className="space-y-3">
          <div className="flex items-center gap-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
            {t('step2Mapping')} <Sparkles className="size-3.5 text-primary" />
            <span className="normal-case tracking-normal text-muted-foreground/70">
              {t('autoFilled')}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <MapField
              label={t('taskFieldLabel')}
              hint={t('taskFieldHint')}
              value={taskField}
              onChange={setTaskField}
              fields={fields}
              sample={sampleOf(taskField)}
            />
            <MapField
              label={t('idFieldLabel')}
              hint={t('idFieldHint')}
              value={idField}
              onChange={setIdField}
              fields={fields}
              sample={sampleOf(idField)}
            />
            <MapField
              label={t('answerFieldLabel')}
              hint={t('answerFieldHint')}
              value={answerField}
              onChange={setAnswerField}
              fields={fields}
              optional
              sample={sampleOf(answerField)}
            />
          </div>

          {/* 결과 서술 — "이 벤치마크가 실제로 어떻게 실행/채점되는지"를 한 문장으로(선택이 아니라 확인). */}
          <div
            className={cn(
              'rounded-lg border px-3.5 py-3 text-[12.5px] leading-relaxed',
              run.tone === 'warn'
                ? 'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/[0.06]'
                : 'border-border bg-secondary/30'
            )}
          >
            <div className="mb-0.5 flex items-center gap-1.5">
              <span className="text-[11px] font-[560] uppercase tracking-wide text-faint">
                {t('runsLikeThis')}
              </span>
              <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] font-[560] text-foreground">
                {run.title}
              </span>
            </div>
            <p className="text-muted-foreground">{run.body}</p>
          </div>

          {/* 고급(작성자) 설정 — 실행 환경 변경 · task 템플릿 · 케이스 이미지/placement. 기본 접힘. */}
          <div className="rounded-lg border bg-card/40">
            <button
              type="button"
              onClick={() => setAdvanced((v) => !v)}
              className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left text-[12.5px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight
                className={cn('size-3.5 transition-transform', advanced && 'rotate-90')}
              />
              <Settings2 className="size-3.5" />
              {t('advancedToggle')}
              <span className="ml-auto text-[11px] font-normal text-faint">
                {t('advancedSummary')}
              </span>
            </button>
            {advanced && (
              <div className="space-y-3 border-t border-border/60 px-3.5 py-3.5">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1">
                    <Label htmlFor="envKind">{t('envKindLabel')}</Label>
                    <InfoTip content={t('envKindTip')} />
                  </div>
                  <Combobox
                    id="envKind"
                    value={envKind}
                    onChange={(v) => setEnvKind(v as EnvKind)}
                    options={[
                      { value: 'prompt', label: t('envPrompt') },
                      { value: 'browser', label: t('envBrowser') },
                      { value: 'repo', label: t('envRepo') },
                      { value: 'os-use', label: t('envOsUse') },
                    ]}
                    className="w-full"
                  />
                </div>

                {envKind === 'browser' && (
                  <MapField
                    label={t('startUrlLabel')}
                    hint={t('startUrlHint')}
                    value={startUrlField}
                    onChange={setStartUrlField}
                    fields={fields}
                    optional
                    sample={sampleOf(startUrlField)}
                  />
                )}
                {envKind === 'repo' && (
                  <div className="grid grid-cols-2 gap-3">
                    <MapField
                      label={t('gitRepoLabel')}
                      hint={t('gitRepoHint')}
                      value={gitField}
                      onChange={setGitField}
                      fields={fields}
                      sample={sampleOf(gitField)}
                    />
                    <MapField
                      label={t('refLabel')}
                      hint={t('refHint')}
                      value={refField}
                      onChange={setRefField}
                      fields={fields}
                      optional
                      sample={sampleOf(refField)}
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <div className="flex items-center gap-1">
                    <Label htmlFor="taskTpl">{t('taskTemplateLabel')}</Label>
                    <InfoTip content={t('taskTemplateTip')} />
                  </div>
                  <Textarea
                    id="taskTpl"
                    className="min-h-16 font-mono text-[12px]"
                    value={taskTemplate}
                    onChange={(e) => setTaskTemplate(e.target.value)}
                    spellCheck={false}
                    placeholder={t('taskTemplatePlaceholder')}
                  />
                  {taskTemplate.trim() && rows[0] ? (
                    <p
                      className="truncate font-mono text-[11px] text-muted-foreground/80"
                      title={taskTemplate.replace(/\{(\w+)\}/g, (_, k) => cellText(rows[0]?.[k]))}
                    >
                      {t('examplePrefix')}{' '}
                      {taskTemplate.replace(/\{(\w+)\}/g, (_, k) => cellText(rows[0]?.[k]))}
                    </p>
                  ) : null}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1">
                      <Label htmlFor="img">{t('caseImageLabel')}</Label>
                      <InfoTip content={t('caseImageTip')} />
                    </div>
                    <Input
                      id="img"
                      value={image}
                      onChange={(e) => setImage(e.target.value)}
                      placeholder={t('caseImagePlaceholder')}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1">
                      <Label htmlFor="place">placement</Label>
                      <InfoTip content={t('placementTip')} />
                    </div>
                    <Input
                      id="place"
                      value={placement}
                      onChange={(e) => setPlacement(e.target.value)}
                      placeholder={t('placementPlaceholder')}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* 3. 만들기 (미리보기 후) — id + (재인입 시에만 버전). 전량 인입이 기본, 실행에서 subset 조절. */}
      {previewed && (
        <section className="space-y-3">
          <div className="text-[11px] font-[510] uppercase tracking-wide text-faint">
            {t('step3Create')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dsid">{t('datasetName')}</Label>
            <Input
              id="dsid"
              value={datasetId}
              onChange={(e) => setDatasetId(e.target.value)}
              placeholder="my-bench"
            />
          </div>
          {/* 버전은 첫 인입이면 자동 1.0.0(숨김) — 같은 이름 재인입일 때만 다음 버전 선택 노출. */}
          {existingVersions.length > 0 && (
            <VersionField existing={existingVersions} value={version} onChange={setVersion} />
          )}

          {createResult && !createResult.ok && (
            <Callout tone="danger">
              {t('createFailed', { error: createResult.error ?? '' })}
            </Callout>
          )}

          <Button
            type="button"
            onClick={onCreate}
            disabled={createBusy || !idField || !taskField}
            className="gap-1.5"
          >
            {createBusy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('createBenchmark')}
          </Button>
          <p className="text-[12px] leading-relaxed text-muted-foreground">{t('createNote')}</p>
        </section>
      )}
    </div>
  )
}

function MapField({
  label,
  hint,
  value,
  onChange,
  fields,
  optional,
  sample,
}: {
  label: string
  hint?: string // label 옆 회색 보조 설명(역할 의미)
  value: string
  onChange: (v: string) => void
  fields: string[]
  optional?: boolean
  sample?: string
}) {
  const t = useTranslations('importBenchmark')
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {hint ? <span className="ml-1 font-normal text-faint">· {hint}</span> : null}
      </Label>
      {/* optional=빈 값 '(없음)' 옵션 노출, 필수=빈 값이면 placeholder 로 선택 유도(기존 native 동작 유지) */}
      <Combobox
        value={value}
        onChange={onChange}
        options={[
          ...(optional ? [{ value: '', label: t('noneOption') }] : []),
          ...fields.map((f) => ({ value: f })),
        ]}
        placeholder={t('selectDash')}
        className="w-full"
        aria-label={label}
      />
      {/* 선택한 필드의 실제 값(첫 행) — "무엇을 매핑하는지" 확인용. */}
      {sample ? (
        <p className="truncate font-mono text-[11px] text-muted-foreground/80" title={sample}>
          {t('examplePrefix')} {sample}
        </p>
      ) : null}
    </div>
  )
}
