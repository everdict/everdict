'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
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
const CRON_PRESETS: { label: string; value: string }[] = [
  { label: '매시간', value: '0 * * * *' },
  { label: '매일 자정', value: '0 0 * * *' },
  { label: '매일 새벽 3시', value: '0 3 * * *' },
  { label: '평일 오전 9시', value: '0 9 * * 1-5' },
  { label: '매주 월요일 9시', value: '0 9 * * 1' },
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
    hint: `${d.versions.length}개 버전`,
  }))
  const harnessIdOptions: ComboboxOption[] = harnesses.map((h) => ({
    value: h.id,
    hint: `${h.versions.length}개 버전`,
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
    else setServerError(res.error ?? (scheduleId ? '예약 수정 실패' : '예약 생성 실패'))
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">이름</Label>
        <Input
          id="name"
          placeholder="nightly-regression"
          {...register('name', { required: '이름을 입력하세요' })}
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
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="cron">cron (분 시 일 월 요일)</Label>
          <Input
            id="cron"
            placeholder="0 3 * * *"
            className="font-mono"
            {...register('cron', {
              required: 'cron 식을 입력하세요',
              pattern: {
                value:
                  /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*(\s+(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*){4}$/,
                message: '5필드 cron 식이어야 합니다 (예: 0 3 * * *)',
              },
            })}
          />
          <FieldError message={errors.cron?.message} />
          <p className="text-[12px] text-muted-foreground">
            예: 매일 03:00 = 0 3 * * *, 평일 15분마다 = */15 * * * 1-5
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="timezone">타임존</Label>
          <Input id="timezone" placeholder="UTC" {...register('timezone')} />
          <p className="text-[12px] text-muted-foreground">IANA tz (예: Asia/Seoul). 기본 UTC.</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="datasetId">데이터셋</Label>
          <Controller
            control={control}
            name="datasetId"
            rules={{ required: '데이터셋을 선택하세요' }}
            render={({ field }) => (
              <Combobox
                id="datasetId"
                options={datasetIdOptions}
                value={field.value}
                onChange={(v) => {
                  field.onChange(v)
                  setValue('datasetVersion', 'latest')
                }}
                placeholder="데이터셋 선택"
                emptyText="데이터셋이 없습니다"
              />
            )}
          />
          <FieldError message={errors.datasetId?.message} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="datasetVersion">버전</Label>
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
          <Label htmlFor="harnessId">하니스</Label>
          <Controller
            control={control}
            name="harnessId"
            rules={{ required: '하니스를 선택하세요' }}
            render={({ field }) => (
              <Combobox
                id="harnessId"
                options={harnessIdOptions}
                value={field.value}
                onChange={(v) => {
                  field.onChange(v)
                  setValue('harnessVersion', 'latest')
                }}
                placeholder="하니스 선택"
                emptyText="하니스가 없습니다"
              />
            )}
          />
          <FieldError message={errors.harnessId?.message} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="harnessVersion">버전</Label>
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
          <Label htmlFor="overlapPolicy">겹침 정책</Label>
          <Controller
            control={control}
            name="overlapPolicy"
            render={({ field }) => (
              <Combobox
                id="overlapPolicy"
                options={[
                  { value: 'skip', label: 'skip (이전 실행 중이면 건너뜀)' },
                  { value: 'bufferOne', label: 'bufferOne (1건 대기)' },
                  { value: 'allowAll', label: 'allowAll (동시 허용)' },
                ]}
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="concurrency">병렬도 (선택)</Label>
          <Input
            id="concurrency"
            type="number"
            min={1}
            max={64}
            placeholder="기본 4"
            {...register('concurrency')}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="runtime">런타임 (선택)</Label>
        <Controller
          control={control}
          name="runtime"
          render={({ field }) => (
            <Combobox
              id="runtime"
              options={[
                { value: '', label: '기본 백엔드' },
                ...runtimes.map((r) => ({ value: r.id })),
              ]}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        <p className="text-[12px] text-muted-foreground">
          셀프호스티드(self:) 런타임은 발사 시점에 러너가 온라인이어야 실행됩니다.
        </p>
      </div>

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <p className="text-[12px] text-muted-foreground">
        지정한 cron 마다 이 데이터셋×하니스로 스코어카드를 실행합니다. 발사 run 은 생성자(나)
        신원으로 돌아가고 결과는 워크스페이스에 기록됩니다(추이/회귀에 그대로 반영).
      </p>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting
          ? scheduleId
            ? '저장 중…'
            : '생성 중…'
          : scheduleId
            ? '변경 저장'
            : '예약 생성'}
      </Button>
    </form>
  )
}
