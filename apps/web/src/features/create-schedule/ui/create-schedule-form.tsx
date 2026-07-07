'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Controller, useForm } from 'react-hook-form'

import { sortSemverDesc } from '@/shared/lib/semver'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'
import { FieldError, Input, Label } from '@/shared/ui/input'

import { createScheduleAction } from '../api/create-schedule'
import { updateScheduleAction } from '../api/update-schedule'

function versionOptions(versions: string[]): ComboboxOption[] {
  const sorted = sortSemverDesc(versions)
  return [
    { value: 'latest', label: 'latest', hint: sorted[0] ? `→ ${sorted[0]}` : undefined },
    ...sorted.map((v) => ({ value: v })),
  ]
}

// cron 프리셋 — raw 입력 대신 흔한 주기를 원클릭으로. 직접 편집도 가능(아래 입력).
const CRON_PRESETS: { labelKey: string; value: string }[] = [
  { labelKey: 'presetHourly', value: '0 * * * *' },
  { labelKey: 'presetMidnight', value: '0 0 * * *' },
  { labelKey: 'presetDaily3am', value: '0 3 * * *' },
  { labelKey: 'presetWeekdays9am', value: '0 9 * * 1-5' },
  { labelKey: 'presetMonday9', value: '0 9 * * 1' },
]

interface Values {
  name: string
  cron: string
  timezone: string
  overlapPolicy: string
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  runtime: string
  concurrency: string
}

// 데이터셋×하니스를 cron 으로 주기 실행하는 예약 생성/수정. 발사·해석은 컨트롤플레인(Temporal Schedule)이 한다.
// scheduleId 가 있으면 수정 모드(PATCH) — initial 로 프리필, initialJudges 로 기존 judge 보존.
export function CreateScheduleForm({
  datasets,
  harnesses,
  runtimes,
  initial,
  scheduleId,
  initialJudges = [],
}: {
  datasets: { id: string; versions: string[] }[]
  harnesses: { id: string; versions: string[] }[]
  runtimes: { id: string }[]
  initial?: Partial<Values>
  scheduleId?: string
  initialJudges?: { id: string; version: string }[]
}) {
  const t = useTranslations('createSchedule')
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [serverError, setServerError] = useState<string>()
  const {
    control,
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    defaultValues: {
      name: '',
      cron: '0 3 * * *',
      timezone: 'UTC',
      overlapPolicy: 'skip',
      datasetId: datasets[0]?.id ?? '',
      datasetVersion: 'latest',
      harnessId: harnesses[0]?.id ?? 'scripted',
      harnessVersion: 'latest',
      runtime: '',
      concurrency: '',
      ...initial,
    },
  })

  const datasetId = watch('datasetId')
  const harnessId = watch('harnessId')
  const cron = watch('cron')
  const datasetIdOptions: ComboboxOption[] = datasets.map((d) => ({
    value: d.id,
    hint: t('versionsCount', { count: d.versions.length }),
  }))
  const harnessIdOptions: ComboboxOption[] = harnesses.map((h) => ({
    value: h.id,
    hint: t('versionsCount', { count: h.versions.length }),
  }))
  const datasetVersionOptions = versionOptions(
    datasets.find((d) => d.id === datasetId)?.versions ?? []
  )
  const harnessVersionOptions = versionOptions(
    harnesses.find((h) => h.id === harnessId)?.versions ?? []
  )

  async function onSubmit(values: Values) {
    setServerError(undefined)
    const { concurrency, ...rest } = values
    const n = Number.parseInt(concurrency, 10)
    const input = { ...rest, ...(Number.isFinite(n) && n > 0 ? { concurrency: n } : {}) }
    const res = scheduleId
      ? await updateScheduleAction(scheduleId, input, initialJudges)
      : await createScheduleAction(input)
    if (res.ok) router.push(`/${workspace}/schedules`)
    else setServerError(res.error ?? (scheduleId ? t('updateFailed') : t('createFailed')))
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">{t('nameLabel')}</Label>
        <Input
          id="name"
          placeholder="nightly-regression"
          {...register('name', { required: t('nameRequired') })}
        />
        <FieldError message={errors.name?.message} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {CRON_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => setValue('cron', p.value, { shouldValidate: true })}
            className={`rounded-md border px-2.5 py-1 text-[12px] font-[510] transition-colors ${
              cron === p.value
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground'
            }`}
          >
            {t(p.labelKey)}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="cron">{t('cronLabel')}</Label>
          <Input
            id="cron"
            placeholder="0 3 * * *"
            className="font-mono"
            {...register('cron', {
              required: t('cronRequired'),
              pattern: {
                value:
                  /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*(\s+(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*){4}$/,
                message: t('cronPattern'),
              },
            })}
          />
          <FieldError message={errors.cron?.message} />
          <p className="text-[12px] text-muted-foreground">{t('cronHint')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="timezone">{t('timezoneLabel')}</Label>
          <Input id="timezone" placeholder="UTC" {...register('timezone')} />
          <p className="text-[12px] text-muted-foreground">{t('timezoneHint')}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="datasetId">{t('datasetLabel')}</Label>
          <Controller
            control={control}
            name="datasetId"
            rules={{ required: t('datasetRequired') }}
            render={({ field }) => (
              <Combobox
                id="datasetId"
                options={datasetIdOptions}
                value={field.value}
                onChange={(v) => {
                  field.onChange(v)
                  setValue('datasetVersion', 'latest')
                }}
                placeholder={t('datasetPlaceholder')}
                emptyText={t('datasetEmpty')}
              />
            )}
          />
          <FieldError message={errors.datasetId?.message} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="datasetVersion">{t('versionLabel')}</Label>
          <Controller
            control={control}
            name="datasetVersion"
            render={({ field }) => (
              <Combobox
                id="datasetVersion"
                options={datasetVersionOptions}
                value={field.value}
                onChange={field.onChange}
                searchable={false}
              />
            )}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="harnessId">{t('harnessLabel')}</Label>
          <Controller
            control={control}
            name="harnessId"
            rules={{ required: t('harnessRequired') }}
            render={({ field }) => (
              <Combobox
                id="harnessId"
                options={harnessIdOptions}
                value={field.value}
                onChange={(v) => {
                  field.onChange(v)
                  setValue('harnessVersion', 'latest')
                }}
                placeholder={t('harnessPlaceholder')}
                emptyText={t('harnessEmpty')}
              />
            )}
          />
          <FieldError message={errors.harnessId?.message} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="harnessVersion">{t('versionLabel')}</Label>
          <Controller
            control={control}
            name="harnessVersion"
            render={({ field }) => (
              <Combobox
                id="harnessVersion"
                options={harnessVersionOptions}
                value={field.value}
                onChange={field.onChange}
                searchable={false}
              />
            )}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="overlapPolicy">{t('overlapLabel')}</Label>
          <Controller
            control={control}
            name="overlapPolicy"
            render={({ field }) => (
              <Combobox
                id="overlapPolicy"
                options={[
                  { value: 'skip', label: t('overlapSkip') },
                  { value: 'bufferOne', label: t('overlapBufferOne') },
                  { value: 'allowAll', label: t('overlapAllowAll') },
                ]}
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="concurrency">{t('concurrencyLabel')}</Label>
          <Input
            id="concurrency"
            type="number"
            min={1}
            max={64}
            placeholder={t('concurrencyPlaceholder')}
            {...register('concurrency')}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="runtime">{t('runtimeLabel')}</Label>
        {/* 실행 위치는 필수 — 컨트롤플레인 호스트 폴백이 금지돼(requireRuntime) 런타임 없는 예약은 발사 때마다 400 실패. */}
        <Controller
          control={control}
          name="runtime"
          rules={{ required: t('runtimeRequired') }}
          render={({ field }) => (
            <Combobox
              id="runtime"
              options={runtimes.map((r) => ({ value: r.id }))}
              value={field.value}
              onChange={field.onChange}
              placeholder={t('runtimePlaceholder')}
              emptyText={t('runtimeEmpty')}
            />
          )}
        />
        <FieldError message={errors.runtime?.message} />
        <p className="text-[12px] text-muted-foreground">{t('runtimeHint')}</p>
      </div>

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <p className="text-[12px] text-muted-foreground">{t('footerNote')}</p>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting
          ? scheduleId
            ? t('saving')
            : t('creating')
          : scheduleId
            ? t('saveChanges')
            : t('createSchedule')}
      </Button>
    </form>
  )
}
