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
// The environment a case runs in — the env kind the mapping decides. browser(startUrl) | prompt(QA, no env) | repo(git clone) | os-use(desktop).
type EnvKind = 'browser' | 'prompt' | 'repo' | 'os-use'

// Field→role visualization. task/id/answer are assigned by clicking a table header (primary color); the rest (git/ref/url) are assigned in the env section (light badge).
const ROLE_META: Record<string, { label: string; color: string }> = {
  task: { label: 'task', color: '#5e6ad2' },
  id: { label: 'id', color: '#3fb6c9' },
  answer: { label: 'answer', color: '#46b96a' },
  git: { label: 'git', color: '#8b93e8' },
  ref: { label: 'ref', color: '#8b93e8' },
  url: { label: 'url', color: '#8b93e8' },
}
const cellText = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

// Execution env → dataset category (display/filter metadata). Not chosen by the user; derived from the env.
const ENV_TO_CATEGORY: Record<EnvKind, Category> = {
  prompt: 'qa',
  browser: 'browser',
  repo: 'coding',
  'os-use': 'tool',
}

// Mapping state → describes "how this benchmark actually runs/scores" in one sentence (a confirmation of the outcome, not a choice).
// tone=warn means the env config is incomplete (needs completion in advanced settings). Word order differs by language, so the sentence is assembled with t.rich.
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

// Guess a mapping from the detected field names — fills in sensible defaults even if the user doesn't know the schema.
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

// "Build from source" wizard: HF is search→select→config/split dropdown (avoids raw id entry); jsonl is paste.
// Then preview detects the fields and dropdown mapping → create a dataset in one shot (inline spec, skipping recipe registration).
export function BuildFromSourceWizard({
  existingDatasets = [],
  hfTokenScope,
}: {
  existingDatasets?: { id: string; versions: string[] }[]
  hfTokenScope?: 'user' | 'workspace' // scope of the available HF_TOKEN — makes the gated indicator state-aware
}) {
  const t = useTranslations('importBenchmark')
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [sourceKind, setSourceKind] = useState<SourceKind>('huggingface')

  // HF search/select
  const [query, setQuery] = useState('')
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState<string | undefined>(undefined)
  const [hits, setHits] = useState<HfDatasetHit[]>([])
  const [hfDataset, setHfDataset] = useState('') // selected dataset id
  const [hfGated, setHfGated] = useState(false)
  const [splits, setSplits] = useState<HfSplit[]>([])
  const [splitSel, setSplitSel] = useState('') // splitKey
  const [splitsNote, setSplitsNote] = useState<string | undefined>(undefined)
  // Fallback for datasets not served by the viewer (datasets-server) — pick a repo data file and fetch it directly.
  const [files, setFiles] = useState<string[]>([])
  const [fileSel, setFileSel] = useState('')

  const [jsonlText, setJsonlText] = useState('')

  const [datasetId, setDatasetId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [advanced, setAdvanced] = useState(false) // advanced (author) settings — execution env/template/image/placement

  const [fields, setFields] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [idField, setIdField] = useState('')
  const [taskField, setTaskField] = useState('')
  const [taskTemplate, setTaskTemplate] = useState('')
  const [answerField, setAnswerField] = useState('')
  const [startUrlField, setStartUrlField] = useState('')
  // env kind + repo/image/placement mapping (expressiveness on par with the first-party catalog).
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
    // Fetch config/split candidates → dropdown.
    const r = await hfSplitsAction(hit.id)
    if (r.ok && r.splits && r.splits.length > 0) {
      setSplits(r.splits)
      // test first, else the first one.
      const pick = r.splits.find((s) => s.split === 'test') ?? r.splits[0]
      if (pick) setSplitSel(splitKey(pick))
      return
    }
    // The viewer doesn't serve this dataset (officeqa-type) → fall back to fetching a repo data file directly.
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
    // In file-fallback mode (not served by the viewer), fetch directly by file — config/split are viewer-only, so omit them.
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
    // Guess the default env: git field → repo, URL → browser, answer → prompt(QA), else browser.
    setEnvKind(git ? 'repo' : url ? 'browser' : ans ? 'prompt' : 'browser')
  }

  // System-managed version — first import is 1.0.0 (field hidden); re-importing the same id lets VersionField compute the next version.
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
      category: ENV_TO_CATEGORY[envKind], // derived from the env (not chosen by the user)
      source: buildSource(),
      mapping: {
        idField,
        taskField,
        ...(taskTemplate.trim() ? { taskTemplate } : {}),
        ...(answerField ? { answerField } : {}),
        // Per-env-kind mapping — expressiveness on par with the first-party catalog (prompt/repo/os-use/browser).
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

  // Back out a field's role from the current mapping state (used to highlight table headers/cells).
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
  // Click a table header → cycle task→id→answer→none. Since it's a single state value, roles stay automatically unique (one column per role).
  function cycleRole(f: string) {
    const order = ['task', 'id', 'answer', ''] as const
    const cur = (['task', 'id', 'answer'] as string[]).includes(roleOf(f)) ? roleOf(f) : ''
    const next = order[(order.indexOf(cur as (typeof order)[number]) + 1) % order.length]
    // Clear this field from all existing roles, then assign the new role.
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
  // Sample value to show under the mapping control (the first row).
  const sampleOf = (f: string): string => (f && rows[0] ? cellText(rows[0][f]) : '')

  return (
    <div className="space-y-6">
      {/* 1. source */}
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
            {/* search */}
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

            {/* search results */}
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

            {/* selected + split */}
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
                          href={`/${workspace}/settings/personal-secrets`}
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
                  // Not served by the viewer → pick a repo data file directly (csv/jsonl/json).
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
                  // gated + no token is the most common failure — point straight to the self-serve path (account secret).
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

      {/* 2. mapping (after preview) — only 3 roles. The rest (execution env/template/image) are auto-inferred + advanced settings. */}
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

          {/* outcome description — "how this benchmark actually runs/scores" in one sentence (a confirmation, not a choice). */}
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

          {/* advanced (author) settings — change execution env · task template · case image/placement. Collapsed by default. */}
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

      {/* 3. create (after preview) — id + (version only on re-import). Importing everything is the default; adjust the subset at run time. */}
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
          {/* Version is auto 1.0.0 on first import (hidden) — the next-version picker is shown only when re-importing the same name. */}
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
  hint?: string // gray auxiliary note next to the label (the role's meaning)
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
      {/* optional=show an empty '(none)' option; required=empty value prompts selection via the placeholder (preserves the original native behavior) */}
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
      {/* the selected field's actual value (first row) — to confirm "what is being mapped". */}
      {sample ? (
        <p className="truncate font-mono text-[11px] text-muted-foreground/80" title={sample}>
          {t('examplePrefix')} {sample}
        </p>
      ) : null}
    </div>
  )
}
