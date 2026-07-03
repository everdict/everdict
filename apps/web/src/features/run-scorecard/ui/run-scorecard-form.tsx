'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Controller, useForm } from 'react-hook-form'

import { sortSemverDesc } from '@/shared/lib/semver'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'
import { FieldError, Input, Label } from '@/shared/ui/input'

import { runScorecardAction } from '../api/run-scorecard'

// 버전 선택지 — 'latest' 별칭(가장 위, 해석 결과를 hint 로) + 등록된 버전들(semver 최신 먼저).
function versionOptions(versions: string[]): ComboboxOption[] {
  const sorted = sortSemverDesc(versions)
  return [
    { value: 'latest', label: 'latest', hint: sorted[0] ? `→ ${sorted[0]}` : undefined },
    ...sorted.map((v) => ({ value: v })),
  ]
}

interface Values {
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  concurrency: string // 병렬도(빈칸=컨트롤플레인 기본). 제출 시 숫자로 파싱.
}

// 벤치마크 × 하니스를 골라 배치 평가를 실행한다. 채점은 벤치마크에 내장 — judge/런타임은 컨트롤플레인 기본값.
export function RunScorecardForm({
  datasets,
  harnesses,
}: {
  datasets: { id: string; versions: string[] }[]
  harnesses: { id: string; versions: string[] }[]
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
      datasetId: datasets[0]?.id ?? '',
      datasetVersion: 'latest',
      harnessId: harnesses[0]?.id ?? 'scripted',
      harnessVersion: 'latest',
      concurrency: '',
    },
  })

  // id 선택에 따라 버전 선택지를 좁힌다(목록에 이미 버전이 실려옴 — 추가 요청 X).
  const datasetId = watch('datasetId')
  const harnessId = watch('harnessId')
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
    const n = Number.parseInt(concurrency, 10) // 빈칸/비정상 → 생략(컨트롤플레인 기본 사용)
    const res = await runScorecardAction({
      ...rest,
      ...(Number.isFinite(n) && n > 0 ? { concurrency: n } : {}),
    })
    if (res.ok && res.id) router.push(`/${workspace}/scorecards/${res.id}`)
    else setServerError(res.error ?? '실행하지 못했어요')
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="datasetId">벤치마크</Label>
          <Controller
            control={control}
            name="datasetId"
            rules={{ required: '벤치마크를 선택하세요' }}
            render={({ field }) => (
              <Combobox
                id="datasetId"
                options={datasetIdOptions}
                value={field.value}
                onChange={(v) => {
                  field.onChange(v)
                  setValue('datasetVersion', 'latest') // id 바뀌면 버전은 latest 로 리셋(이전 버전이 새 id 엔 없을 수 있음).
                }}
                placeholder="벤치마크 선택"
                emptyText="벤치마크가 없어요"
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
                emptyText="하니스가 없어요"
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

      <div className="space-y-1.5">
        <Label htmlFor="concurrency">한 번에 실행할 케이스 수 (선택)</Label>
        <Input
          id="concurrency"
          type="number"
          min={1}
          max={64}
          placeholder="기본 4"
          {...register('concurrency')}
        />
        <p className="text-[12px] text-muted-foreground">
          한 번에 몇 개를 돌릴지 정해요. 비워두면 기본값으로 실행해요.
        </p>
      </div>

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <p className="text-[12px] text-muted-foreground">
        벤치마크의 모든 케이스를 이 하니스로 평가해 점수를 모아요. 실행이 끝나면 상세 화면에서 결과를
        확인해요.
      </p>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? '실행 중…' : '스코어카드 실행'}
      </Button>
    </form>
  )
}
