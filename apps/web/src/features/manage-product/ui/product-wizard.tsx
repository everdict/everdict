'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FolderTree,
  Loader2,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  productHref,
  type ProductRepoDiscovery,
  type ProductSeries,
  type ProductService,
} from '@/entities/product'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'
import { MultiSelect } from '@/shared/ui/multi-select'

import { createProductAction, discoverRepoAction, syncProductAction } from '../api/products'
import type { RepoOption } from './product-form'

// 프로덕트 생성 위자드 — 원칙은 하나다: **치게 하지 말고 고르게 한다.**
// 서비스 행에서 사람을 가장 자주 배신하는 필드는 tagPrefix 다. `api-` 라고 쳤는데 실제 태그가 `api/v1.2.0`
// 이면 아무 데도 에러가 나지 않는다 — 싱크는 "0개 임포트"라고 말하고 타임라인은 영원히 비어 있다. 그래서
// 이 위자드는 레포를 먼저 읽고(발행 중인 버전 스트림 + 트리의 배포 단위), 거기서 나온 제안을 체크하게 한다.
// 모노레포는 이 구조에서 자연스럽다: 한 레포가 여러 subpath 를 갖고, 각 subpath 가 자기 태그 스트림을 갖거나
// 레포 전역 스트림을 함께 탄다.

const STEPS = ['basics', 'services', 'series', 'review'] as const
type Step = (typeof STEPS)[number]

interface ServiceRow {
  name: string
  repository: string
  host: string
  source: 'releases' | 'tags'
  tagPrefix: string
  path: string
}

interface SeriesRow {
  key: string
  label: string
  datasetId: string
  harnessId: string
  judgeIds: string[]
}

function slugOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

const repoKeyOf = (repository: string, host?: string): string =>
  host ? `${repository}@@${host}` : repository

// 서비스 행 하나의 정체성 — 이름이 아니라 좌표다(같은 레포에서 프리픽스만 다른 두 서비스가 공존한다).
const rowKeyOf = (row: Pick<ServiceRow, 'repository' | 'host' | 'tagPrefix' | 'path'>): string =>
  [row.host, row.repository, row.tagPrefix, row.path].join('')

// 프리픽스가 실제로 무엇을 집는지 — 싱크와 **같은 규칙**(startsWith, 없으면 전부)으로 표본을 다시 센다.
// 서버 왕복 없이 즉시 갱신되므로 프리픽스를 손보는 순간 "몇 개가 잡히는지"가 눈에 보인다.
function previewOf(
  discovery: ProductRepoDiscovery | undefined,
  tagPrefix: string
): { count: number; latest?: string; first?: string } {
  if (discovery === undefined) return { count: 0 }
  const matched = discovery.versions.filter((v) => tagPrefix === '' || v.name.startsWith(tagPrefix))
  const dates = matched.map((v) => v.publishedAt).filter((at): at is string => at !== undefined)
  dates.sort()
  return {
    count: matched.length,
    ...(dates.at(-1) !== undefined ? { latest: dates.at(-1) } : {}),
    ...(dates[0] !== undefined ? { first: dates[0] } : {}),
  }
}

export function ProductWizard({
  workspace,
  datasetOptions,
  harnessOptions,
  judgeOptions,
  repoOptions,
}: {
  workspace: string
  datasetOptions: string[]
  harnessOptions: string[]
  judgeOptions: string[]
  repoOptions: RepoOption[]
}) {
  const t = useTranslations('productsPage')
  const router = useRouter()
  const [step, setStep] = useState<Step>('basics')
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('')
  const [description, setDescription] = useState('')
  // 읽어 본 레포들 — 제안의 출처이자, 프리픽스 프리뷰가 다시 세는 표본.
  const [discoveries, setDiscoveries] = useState<Record<string, ProductRepoDiscovery>>({})
  const [repoValue, setRepoValue] = useState('')
  const [reading, setReading] = useState(false)
  const [services, setServices] = useState<ServiceRow[]>([])
  const [series, setSeries] = useState<SeriesRow[]>([])
  const [syncAfter, setSyncAfter] = useState(true)
  const [pending, setPending] = useState(false)

  const selected = useMemo(() => new Set(services.map(rowKeyOf)), [services])

  function patchService(index: number, patch: Partial<ServiceRow>) {
    setServices((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  // 레포 하나를 읽고, 스트림이 뒷받침하는 제안(recommended)만 미리 담는다 — 나머지는 체크로 담게 둔다.
  function readRepo() {
    const [repository = '', host = ''] = repoValue.split('@@')
    if (repository.length === 0) return
    void (async () => {
      setReading(true)
      try {
        const r = await discoverRepoAction({ repository, ...(host.length > 0 ? { host } : {}) })
        if (!r.ok || !r.discovery) {
          toast.error(r.error ?? t('wizardReadError'))
          return
        }
        const discovery = r.discovery
        setDiscoveries((current) => ({
          ...current,
          [repoKeyOf(repository, host || undefined)]: discovery,
        }))
        setServices((rows) => {
          const known = new Set(rows.map(rowKeyOf))
          const added = discovery.suggestions
            .filter((suggestion) => suggestion.recommended)
            .map((suggestion) => ({
              name: suggestion.name,
              repository,
              host,
              source: suggestion.source,
              tagPrefix: suggestion.tagPrefix ?? '',
              path: suggestion.path ?? '',
            }))
            .filter((row) => !known.has(rowKeyOf(row)))
          return [...rows, ...added]
        })
      } finally {
        setReading(false)
      }
    })()
  }

  function toggleSuggestion(
    repository: string,
    host: string,
    suggestion: ProductRepoDiscovery['suggestions'][number]
  ) {
    const row: ServiceRow = {
      name: suggestion.name,
      repository,
      host,
      source: suggestion.source,
      tagPrefix: suggestion.tagPrefix ?? '',
      path: suggestion.path ?? '',
    }
    setServices((rows) =>
      rows.some((existing) => rowKeyOf(existing) === rowKeyOf(row))
        ? rows.filter((existing) => rowKeyOf(existing) !== rowKeyOf(row))
        : [...rows, row]
    )
  }

  function submit() {
    if (name.trim().length === 0) return
    const payloadServices: ProductService[] = services
      .filter((row) => row.name.trim().length > 0 && row.repository.trim().length > 0)
      .map((row) => ({
        name: row.name.trim(),
        repository: row.repository.trim(),
        ...(row.host.trim().length > 0 ? { host: row.host.trim() } : {}),
        source: row.source,
        ...(row.tagPrefix.trim().length > 0 ? { tagPrefix: row.tagPrefix.trim() } : {}),
        ...(row.path.trim().length > 0 ? { path: row.path.trim() } : {}),
      }))
    const payloadSeries: ProductSeries[] = series
      .filter((row) => row.key.length > 0 && row.datasetId.length > 0 && row.harnessId.length > 0)
      .map((row) => ({
        key: row.key,
        label: row.label.trim().length > 0 ? row.label.trim() : row.key,
        dataset: { id: row.datasetId },
        harness: { id: row.harnessId },
        judges: row.judgeIds.map((id) => ({ id })),
      }))
    void (async () => {
      setPending(true)
      try {
        const r = await createProductAction({
          name: name.trim(),
          ...(description.trim().length > 0 ? { description: description.trim() } : {}),
          ...(icon.trim().length > 0 ? { icon: icon.trim() } : {}),
          ...(payloadServices.length > 0 ? { services: payloadServices } : {}),
          ...(payloadSeries.length > 0 ? { series: payloadSeries } : {}),
        })
        if (!r.ok || !r.product) {
          toast.error(r.error ?? t('createError'))
          return
        }
        // 첫 싱크는 백필이다: 릴리즈 이력이 조용히 들어와 시간축이 생기고, 아무것도 평가되지 않는다.
        // 실패해도 프로덕트는 이미 만들어졌으므로 이동은 막지 않는다(상세에서 다시 누를 수 있다).
        if (syncAfter && payloadServices.length > 0) {
          const sync = await syncProductAction(r.product.id)
          if (!sync.ok) toast.error(sync.error ?? t('syncError'))
        }
        router.push(productHref(workspace, r.product.id))
      } finally {
        setPending(false)
      }
    })()
  }

  const index = STEPS.indexOf(step)
  const canGoNext = step === 'basics' ? name.trim().length > 0 : true

  return (
    <div className="@container space-y-6">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {STEPS.map((entry, i) => (
          <li key={entry} className="flex items-center gap-2">
            <button
              type="button"
              // 뒤로는 언제든, 앞으로는 이름이 있어야 — 절차가 아니라 안내다.
              onClick={() => (i < index || name.trim().length > 0) && setStep(entry)}
              className={cn(
                'rounded-md px-2 py-1 transition-colors',
                entry === step
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {i + 1}. {t(`wizardStep_${entry}`)}
            </button>
            {i < STEPS.length - 1 && <ChevronRight className="size-3 text-muted-foreground/60" />}
          </li>
        ))}
      </ol>

      {step === 'basics' && (
        <section className="space-y-4">
          <div className="grid gap-3 @md:grid-cols-[6rem_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="product-icon">{t('fieldIcon')}</Label>
              <Input
                id="product-icon"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="📦"
                maxLength={8}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="product-name">{t('fieldName')}</Label>
              <Input
                id="product-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('fieldNamePlaceholder')}
                autoFocus
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="product-description">{t('fieldDescription')}</Label>
            <Textarea
              id="product-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
        </section>
      )}

      {step === 'services' && (
        <section className="space-y-4">
          <p className="text-xs text-muted-foreground">{t('wizardServicesHint')}</p>
          {repoOptions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('noAppHint')}{' '}
              <Link
                href={`/${workspace}/settings/integrations`}
                className="underline hover:text-foreground"
              >
                {t('noAppLink')}
              </Link>
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1 space-y-1.5">
                <Label>{t('wizardPickRepo')}</Label>
                <Combobox
                  options={repoOptions.map((repo) => ({
                    value: repoKeyOf(repo.fullName, repo.host),
                    label:
                      repo.host !== undefined ? `${repo.fullName} · ${repo.host}` : repo.fullName,
                  }))}
                  value={repoValue}
                  onChange={setRepoValue}
                  searchable
                  placeholder={t('serviceRepositoryPick')}
                  aria-label={t('serviceRepository')}
                />
              </div>
              <Button
                variant="outline"
                onClick={readRepo}
                disabled={reading || repoValue.length === 0}
              >
                {reading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Search className="size-3.5" />
                )}
                {t('wizardReadRepo')}
              </Button>
            </div>
          )}

          {Object.entries(discoveries).map(([key, discovery]) => {
            const [repository = '', host = ''] = key.split('@@')
            return (
              <div key={key} className="space-y-2 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{repository}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {t('wizardFound', {
                      versions: discovery.versions.length,
                      packages: discovery.packages.length,
                      source: t(discovery.source === 'releases' ? 'sourceReleases' : 'sourceTags'),
                    })}
                    {!discovery.complete && ` · ${t('wizardPartialRead')}`}
                  </span>
                </div>
                <ul className="space-y-1">
                  {discovery.suggestions.map((suggestion) => {
                    const row = {
                      repository,
                      host,
                      tagPrefix: suggestion.tagPrefix ?? '',
                      path: suggestion.path ?? '',
                    }
                    const checked = selected.has(rowKeyOf(row))
                    const preview = previewOf(discovery, suggestion.tagPrefix ?? '')
                    return (
                      <li
                        key={`${suggestion.name}${suggestion.tagPrefix ?? ''}${suggestion.path ?? ''}`}
                      >
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={checked}
                          onClick={() => toggleSuggestion(repository, host, suggestion)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors',
                            checked
                              ? 'border-primary/40 bg-primary/5'
                              : 'border-transparent hover:bg-muted/60'
                          )}
                        >
                          <span
                            className={cn(
                              'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                              checked
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border'
                            )}
                          >
                            {checked && <Check className="size-3" />}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm">{suggestion.name}</span>
                          {suggestion.path !== undefined && (
                            <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                              <FolderTree className="size-3" />
                              {suggestion.path}
                            </span>
                          )}
                          {suggestion.tagPrefix !== undefined && (
                            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                              {suggestion.tagPrefix}*
                            </code>
                          )}
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {preview.latest !== undefined
                              ? t('wizardStreamWithDate', {
                                  count: preview.count,
                                  at: preview.latest.slice(0, 10),
                                })
                              : t('wizardStream', { count: preview.count })}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{t('wizardSelectedServices')}</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setServices((rows) => [
                    ...rows,
                    {
                      name: '',
                      repository: '',
                      host: '',
                      source: 'releases',
                      tagPrefix: '',
                      path: '',
                    },
                  ])
                }
              >
                <Plus className="size-3.5" />
                {t('addService')}
              </Button>
            </div>
            {services.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('wizardNoServices')}</p>
            )}
            {services.map((row, i) => {
              const preview = previewOf(
                discoveries[repoKeyOf(row.repository, row.host || undefined)],
                row.tagPrefix
              )
              return (
                <div
                  key={`${rowKeyOf(row)}-${i}`}
                  className="space-y-2 rounded-md border border-border p-3"
                >
                  <div className="grid gap-2 @md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_8rem]">
                    <Input
                      value={row.name}
                      onChange={(e) => patchService(i, { name: e.target.value })}
                      placeholder={t('serviceName')}
                      aria-label={t('serviceName')}
                    />
                    <Input
                      value={row.repository}
                      onChange={(e) => patchService(i, { repository: e.target.value })}
                      placeholder="owner/repository"
                      aria-label={t('serviceRepository')}
                    />
                    <Combobox
                      options={[
                        { value: 'releases', label: t('sourceReleases') },
                        { value: 'tags', label: t('sourceTags') },
                      ]}
                      value={row.source}
                      onChange={(value) =>
                        patchService(i, { source: value as ServiceRow['source'] })
                      }
                      aria-label={t('serviceSource')}
                    />
                  </div>
                  <div className="grid gap-2 @md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <Input
                      value={row.path}
                      onChange={(e) => patchService(i, { path: e.target.value })}
                      placeholder={t('servicePathPlaceholder')}
                      aria-label={t('servicePath')}
                    />
                    <Input
                      value={row.tagPrefix}
                      onChange={(e) => patchService(i, { tagPrefix: e.target.value })}
                      placeholder={t('serviceTagPrefix')}
                      aria-label={t('serviceTagPrefix')}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setServices((rows) => rows.filter((_, j) => j !== i))}
                      aria-label={t('removeRow')}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  <p
                    className={cn(
                      'text-[11px]',
                      preview.count === 0 ? 'text-warning' : 'text-muted-foreground'
                    )}
                  >
                    {preview.first !== undefined && preview.latest !== undefined
                      ? t('wizardPreviewRange', {
                          count: preview.count,
                          from: preview.first.slice(0, 10),
                          to: preview.latest.slice(0, 10),
                        })
                      : t('wizardPreviewCount', { count: preview.count })}
                  </p>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {step === 'series' && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t('seriesHeading')}</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setSeries((rows) => [
                  ...rows,
                  { key: '', label: '', datasetId: '', harnessId: '', judgeIds: [] },
                ])
              }
            >
              <Plus className="size-3.5" />
              {t('addSeries')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('seriesHint')}</p>
          {series.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('wizardSeriesOptional')}</p>
          )}
          {series.map((row, i) => (
            <div key={i} className="space-y-2 rounded-md border border-border p-3">
              <div className="grid gap-2 @md:grid-cols-2">
                <div className="space-y-1">
                  <Label>{t('seriesLabel')}</Label>
                  <Input
                    value={row.label}
                    onChange={(e) =>
                      setSeries((rows) =>
                        rows.map((entry, j) =>
                          j === i
                            ? {
                                ...entry,
                                label: e.target.value,
                                ...(entry.key === slugOf(entry.label) || entry.key === ''
                                  ? { key: slugOf(e.target.value) }
                                  : {}),
                              }
                            : entry
                        )
                      )
                    }
                    placeholder={t('seriesLabelPlaceholder')}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t('seriesKey')}</Label>
                  <Input
                    value={row.key}
                    onChange={(e) =>
                      setSeries((rows) =>
                        rows.map((entry, j) =>
                          j === i ? { ...entry, key: slugOf(e.target.value) } : entry
                        )
                      )
                    }
                    placeholder="support-quality"
                  />
                </div>
              </div>
              <div className="grid gap-2 @md:grid-cols-3">
                <div className="space-y-1">
                  <Label>{t('seriesDataset')}</Label>
                  <Combobox
                    options={datasetOptions.map((id) => ({ value: id, label: id }))}
                    value={row.datasetId}
                    onChange={(value) =>
                      setSeries((rows) =>
                        rows.map((entry, j) => (j === i ? { ...entry, datasetId: value } : entry))
                      )
                    }
                    placeholder={t('pick')}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t('seriesHarness')}</Label>
                  <Combobox
                    options={harnessOptions.map((id) => ({ value: id, label: id }))}
                    value={row.harnessId}
                    onChange={(value) =>
                      setSeries((rows) =>
                        rows.map((entry, j) => (j === i ? { ...entry, harnessId: value } : entry))
                      )
                    }
                    placeholder={t('pick')}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t('seriesJudges')}</Label>
                  <MultiSelect
                    options={judgeOptions.map((id) => ({ value: id, label: id }))}
                    selected={row.judgeIds}
                    onChange={(next) =>
                      setSeries((rows) =>
                        rows.map((entry, j) => (j === i ? { ...entry, judgeIds: next } : entry))
                      )
                    }
                    placeholder={t('seriesJudgesPlaceholder')}
                    emptyLabel={t('seriesJudgesPlaceholder')}
                    removeLabel={(judge) => t('removeJudge', { name: judge })}
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSeries((rows) => rows.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-3.5" />
                  {t('removeRow')}
                </Button>
              </div>
            </div>
          ))}
        </section>
      )}

      {step === 'review' && (
        <section className="space-y-4">
          <dl className="grid gap-2 text-sm @md:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t('fieldName')}</dt>
              <dd>
                {icon} {name}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('servicesHeading')}</dt>
              <dd>{t('serviceCount', { count: services.length })}</dd>
            </div>
          </dl>
          <ul className="space-y-1 text-sm">
            {services.map((row, i) => (
              <li
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
              >
                <span className="font-medium">{row.name}</span>
                <span className="text-xs text-muted-foreground">{row.repository}</span>
                {row.path.length > 0 && (
                  <span className="text-[11px] text-muted-foreground">/{row.path}</span>
                )}
                {row.tagPrefix.length > 0 && (
                  <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{row.tagPrefix}*</code>
                )}
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={syncAfter}
              onChange={(e) => setSyncAfter(e.target.checked)}
              className="size-3.5 accent-[var(--color-primary)]"
            />
            {t('wizardSyncAfter')}
          </label>
          <p className="text-xs text-muted-foreground">{t('wizardSyncAfterHint')}</p>
        </section>
      )}

      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          onClick={() => setStep(STEPS[Math.max(0, index - 1)] ?? 'basics')}
          disabled={index === 0}
        >
          <ChevronLeft className="size-3.5" />
          {t('wizardBack')}
        </Button>
        {step === 'review' ? (
          <Button onClick={submit} disabled={pending || name.trim().length === 0}>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            {t('createSubmit')}
          </Button>
        ) : (
          <Button onClick={() => setStep(STEPS[index + 1] ?? 'review')} disabled={!canGoNext}>
            {t('wizardNext')}
            <ChevronRight className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}
