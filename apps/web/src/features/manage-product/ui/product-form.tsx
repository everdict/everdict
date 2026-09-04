'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  productHref,
  productRef,
  type ProductSeries,
  type ProductService,
} from '@/entities/product'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'
import { MultiSelect } from '@/shared/ui/multi-select'

import { createProductAction, updateProductAction } from '../api/products'

interface ServiceRow {
  name: string
  repository: string
  host: string
  source: 'releases' | 'tags'
  tagPrefix: string
  // Where this service lives in the monorepo — configuration rather than stream identity, so the watermark survives a change to it.
  path: string
}

interface SeriesRow {
  key: string
  label: string
  datasetId: string
  harnessId: string
  judgeIds: string[]
}

// A series key is the trend's durable identity — a slug is suggested from the label, but it stays hand-editable.
function slugOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

// One repo the GitHub App offers — the value encoding is `fullName` (GHE uses `fullName@@host`).
export interface RepoOption {
  fullName: string
  host?: string
  private: boolean
}

const repoValueOf = (repo: { fullName: string; host?: string }): string =>
  repo.host !== undefined ? `${repo.fullName}@@${repo.host}` : repo.fullName

// The existing product the form is prefilled with — present, it is edit mode. The form never touches a service's sync state
// (the aggregate carries the watermark forward as long as the source coordinates are unchanged).
export interface ProductFormInitial {
  id: string
  name: string
  icon?: string
  description?: string
  services: {
    name: string
    repository: string
    host?: string
    source: 'releases' | 'tags'
    tagPrefix?: string
    path?: string
  }[]
  series: {
    key: string
    label: string
    dataset: { id: string }
    harness: { id: string }
    judges: { id: string }[]
  }[]
}

// The product register/edit form. The choices are narrowed by the SERVER (the picker rule): the datasets, harnesses and judges are ids the
// workspace actually registered, and the control plane refuses an id that does not exist with a 400.
export function ProductForm({
  workspace,
  datasetOptions,
  harnessOptions,
  judgeOptions,
  repoOptions,
  initial,
}: {
  workspace: string
  datasetOptions: string[]
  harnessOptions: string[]
  judgeOptions: string[]
  // The GitHub App's installed repos — the set a sync can actually reach. Empty, it falls back to manual entry.
  repoOptions: RepoOption[]
  initial?: ProductFormInitial
}) {
  const t = useTranslations('productsPage')
  const router = useRouter()
  const [name, setName] = useState(initial?.name ?? '')
  const [icon, setIcon] = useState(initial?.icon ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [services, setServices] = useState<ServiceRow[]>(
    (initial?.services ?? []).map((row) => ({
      name: row.name,
      repository: row.repository,
      host: row.host ?? '',
      source: row.source,
      tagPrefix: row.tagPrefix ?? '',
      path: row.path ?? '',
    }))
  )
  const [series, setSeries] = useState<SeriesRow[]>(
    (initial?.series ?? []).map((row) => ({
      key: row.key,
      label: row.label,
      datasetId: row.dataset.id,
      harnessId: row.harness.id,
      judgeIds: row.judges.map((judge) => judge.id),
    }))
  )
  const [pending, setPending] = useState(false)

  function patchService(index: number, patch: Partial<ServiceRow>) {
    setServices((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function patchSeries(index: number, patch: Partial<SeriesRow>) {
    setSeries((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
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
        // An edit sends the WHOLE result set (the list-replacement rule) — an empty list is a real answer too ("I deleted them all").
        const r = initial
          ? await updateProductAction(initial.id, {
              name: name.trim(),
              description: description.trim().length > 0 ? description.trim() : null,
              icon: icon.trim().length > 0 ? icon.trim() : null,
              services: payloadServices,
              series: payloadSeries,
            })
          : await createProductAction({
              name: name.trim(),
              ...(description.trim().length > 0 ? { description: description.trim() } : {}),
              ...(icon.trim().length > 0 ? { icon: icon.trim() } : {}),
              ...(payloadServices.length > 0 ? { services: payloadServices } : {}),
              ...(payloadSeries.length > 0 ? { series: payloadSeries } : {}),
            })
        if (!r.ok || !r.product) {
          toast.error(r.error ?? t(initial ? 'updateError' : 'createError'))
          return
        }
        router.push(productHref(workspace, productRef(r.product)))
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <div className="@container space-y-6">
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

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('servicesHeading')}</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setServices((rows) => [
                ...rows,
                { name: '', repository: '', host: '', source: 'releases', tagPrefix: '', path: '' },
              ])
            }
          >
            <Plus className="size-3.5" />
            {t('addService')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('servicesHint')}</p>
        {repoOptions.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t('noAppHint')}{' '}
            <Link
              href={`/${workspace}/settings/integrations`}
              className="underline hover:text-foreground"
            >
              {t('noAppLink')}
            </Link>
          </p>
        )}
        {services.map((row, index) => (
          // The name is the identity, but it can be empty mid-edit, so rows are drawn by index (empty rows are filtered out on submit).
          <div
            key={index}
            className="grid gap-2 @md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_7rem_7rem_7rem_auto]"
          >
            <Input
              value={row.name}
              onChange={(e) => patchService(index, { name: e.target.value })}
              placeholder={t('serviceName')}
              aria-label={t('serviceName')}
            />
            {repoOptions.length > 0 ? (
              // With the GitHub App present a repo is PICKED — the picker offers only what the control plane will accept
              // (a repo outside the installation fails anyway, since the sync cannot get a token). An empty name is filled from the repo's tail.
              <Combobox
                options={repoOptions.map((repo) => ({
                  value: repoValueOf(repo),
                  label:
                    repo.host !== undefined ? `${repo.fullName} · ${repo.host}` : repo.fullName,
                }))}
                value={repoValueOf({
                  fullName: row.repository,
                  ...(row.host.length > 0 ? { host: row.host } : {}),
                })}
                onChange={(value) => {
                  const [fullName = '', host = ''] = value.split('@@')
                  const tail = fullName.split('/').at(-1) ?? ''
                  patchService(index, {
                    repository: fullName,
                    host,
                    ...(row.name.trim().length === 0 ? { name: tail } : {}),
                  })
                }}
                searchable
                placeholder={t('serviceRepositoryPick')}
                aria-label={t('serviceRepository')}
              />
            ) : (
              <Input
                value={row.repository}
                onChange={(e) => patchService(index, { repository: e.target.value })}
                placeholder="owner/repository"
                aria-label={t('serviceRepository')}
              />
            )}
            <Combobox
              options={[
                { value: 'releases', label: t('sourceReleases') },
                { value: 'tags', label: t('sourceTags') },
              ]}
              value={row.source}
              onChange={(value) => patchService(index, { source: value as ServiceRow['source'] })}
              aria-label={t('serviceSource')}
            />
            <Input
              value={row.tagPrefix}
              onChange={(e) => patchService(index, { tagPrefix: e.target.value })}
              placeholder={t('serviceTagPrefix')}
              aria-label={t('serviceTagPrefix')}
            />
            <Input
              value={row.path}
              onChange={(e) => patchService(index, { path: e.target.value })}
              placeholder={t('servicePathPlaceholder')}
              aria-label={t('servicePath')}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setServices((rows) => rows.filter((_, i) => i !== index))}
              aria-label={t('removeRow')}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </section>

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
        {series.map((row, index) => (
          <div key={index} className="space-y-2 rounded-md border border-border p-3">
            <div className="grid gap-2 @md:grid-cols-2">
              <div className="space-y-1">
                <Label>{t('seriesLabel')}</Label>
                <Input
                  value={row.label}
                  onChange={(e) =>
                    patchSeries(index, {
                      label: e.target.value,
                      // The key follows the label until it is touched — after a save the key stays even when the label changes.
                      ...(row.key === slugOf(row.label) || row.key === ''
                        ? { key: slugOf(e.target.value) }
                        : {}),
                    })
                  }
                  placeholder={t('seriesLabelPlaceholder')}
                />
              </div>
              <div className="space-y-1">
                <Label>{t('seriesKey')}</Label>
                <Input
                  value={row.key}
                  onChange={(e) => patchSeries(index, { key: slugOf(e.target.value) })}
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
                  onChange={(value) => patchSeries(index, { datasetId: value })}
                  placeholder={t('pick')}
                />
              </div>
              <div className="space-y-1">
                <Label>{t('seriesHarness')}</Label>
                <Combobox
                  options={harnessOptions.map((id) => ({ value: id, label: id }))}
                  value={row.harnessId}
                  onChange={(value) => patchSeries(index, { harnessId: value })}
                  placeholder={t('pick')}
                />
              </div>
              <div className="space-y-1">
                <Label>{t('seriesJudges')}</Label>
                <MultiSelect
                  options={judgeOptions.map((id) => ({ value: id, label: id }))}
                  selected={row.judgeIds}
                  onChange={(next) => patchSeries(index, { judgeIds: next })}
                  placeholder={t('seriesJudgesPlaceholder')}
                  emptyLabel={t('seriesJudgesPlaceholder')}
                  removeLabel={(name) => t('removeJudge', { name })}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSeries((rows) => rows.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-3.5" />
                {t('removeRow')}
              </Button>
            </div>
          </div>
        ))}
      </section>

      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending || name.trim().length === 0}>
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          {t(initial ? 'updateSubmit' : 'createSubmit')}
        </Button>
      </div>
    </div>
  )
}
