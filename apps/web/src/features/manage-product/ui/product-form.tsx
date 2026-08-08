'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { productHref, type ProductSeries, type ProductService } from '@/entities/product'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { MultiSelect } from '@/shared/ui/multi-select'

import { createProductAction } from '../api/products'

interface ServiceRow {
  name: string
  repository: string
  source: 'releases' | 'tags'
  tagPrefix: string
}

interface SeriesRow {
  key: string
  label: string
  datasetId: string
  harnessId: string
  judgeIds: string[]
}

// 시리즈 key 는 추이의 영속 정체성 — 라벨에서 슬러그를 만들어 주되, 손으로 고칠 수 있게 둔다.
function slugOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

// 프로덕트 등록 폼. 선택지는 서버가 좁혀 온다(피커 규칙): 데이터셋/하네스/저지는 워크스페이스가 실제로
// 등록한 id 들이고, 컨트롤 플레인은 없는 id 를 400 으로 거절한다.
export function ProductForm({
  workspace,
  datasetOptions,
  harnessOptions,
  judgeOptions,
}: {
  workspace: string
  datasetOptions: string[]
  harnessOptions: string[]
  judgeOptions: string[]
}) {
  const t = useTranslations('productsPage')
  const router = useRouter()
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('')
  const [description, setDescription] = useState('')
  const [services, setServices] = useState<ServiceRow[]>([])
  const [series, setSeries] = useState<SeriesRow[]>([])
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
        source: row.source,
        ...(row.tagPrefix.trim().length > 0 ? { tagPrefix: row.tagPrefix.trim() } : {}),
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
        router.push(productHref(workspace, r.product.id))
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
              setServices((rows) => [...rows, { name: '', repository: '', source: 'releases', tagPrefix: '' }])
            }
          >
            <Plus className="size-3.5" />
            {t('addService')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('servicesHint')}</p>
        {services.map((row, index) => (
          // 이름이 정체성이지만 편집 중에는 비어 있을 수 있어 index 로 그린다(제출 시 빈 행은 걸러진다).
          <div key={index} className="grid gap-2 @md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_8rem_8rem_auto]">
            <Input
              value={row.name}
              onChange={(e) => patchService(index, { name: e.target.value })}
              placeholder={t('serviceName')}
              aria-label={t('serviceName')}
            />
            <Input
              value={row.repository}
              onChange={(e) => patchService(index, { repository: e.target.value })}
              placeholder="owner/repository"
              aria-label={t('serviceRepository')}
            />
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
              setSeries((rows) => [...rows, { key: '', label: '', datasetId: '', harnessId: '', judgeIds: [] }])
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
                      // key 를 손대기 전까지는 라벨을 따라간다 — 저장 뒤에는 라벨을 바꿔도 key 는 남는다.
                      ...(row.key === slugOf(row.label) || row.key === '' ? { key: slugOf(e.target.value) } : {}),
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
          {t('createSubmit')}
        </Button>
      </div>
    </div>
  )
}
