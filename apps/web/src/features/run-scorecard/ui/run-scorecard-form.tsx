'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Controller, useForm } from 'react-hook-form'

import { sortSemverDesc } from '@/shared/lib/semver'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'
import { FieldError, Input, Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import { runScorecardAction } from '../api/run-scorecard'

// 버전 선택지 — 'latest' 별칭(가장 위, 해석 결과+태그를 hint 로) + 등록된 버전들(semver 최신 먼저, 태그 있으면 hint).
// versionTags = 버전 → 자유 라벨(태그 있는 버전만). 번호만으로 분간하기 어려운 버전을 태그로 식별.
function versionOptions(
  versions: string[],
  versionTags?: Record<string, string[]>
): ComboboxOption[] {
  const sorted = sortSemverDesc(versions)
  const latest = sorted[0]
  const latestTags = latest ? (versionTags?.[latest] ?? []) : []
  return [
    {
      value: 'latest',
      label: 'latest',
      hint: latest
        ? `→ ${latest}${latestTags.length > 0 ? ` · ${latestTags.join(' · ')}` : ''}`
        : undefined,
    },
    ...sorted.map((v) => {
      const tags = versionTags?.[v] ?? []
      return { value: v, ...(tags.length > 0 ? { hint: tags.join(' · ') } : {}) }
    }),
  ]
}

interface Values {
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  concurrency: string // 병렬도(빈칸=컨트롤플레인 기본). 제출 시 숫자로 파싱.
  caseLimit: string // 부분 실행 — 앞에서 N개만(빈칸=전체). 제출 시 숫자로 파싱.
  caseTags: string // 부분 실행 — 태그 필터(쉼표 구분, any-match. 빈칸=전체)
}

// 벤치마크 × 하니스를 골라 배치 평가를 실행한다. 채점은 벤치마크에 내장 — judge/런타임은 컨트롤플레인 기본값.
export function RunScorecardForm({
  datasets,
  harnesses,
}: {
  datasets: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[]
  harnesses: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[]
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
      caseLimit: '',
      caseTags: '',
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
  const datasetEntry = datasets.find((d) => d.id === datasetId)
  const harnessEntry = harnesses.find((h) => h.id === harnessId)
  const datasetVersionOptions = versionOptions(
    datasetEntry?.versions ?? [],
    datasetEntry?.versionTags
  )
  const harnessVersionOptions = versionOptions(
    harnessEntry?.versions ?? [],
    harnessEntry?.versionTags
  )

  async function onSubmit(values: Values) {
    setServerError(undefined)
    const { concurrency, caseLimit, caseTags, ...rest } = values
    const n = Number.parseInt(concurrency, 10) // 빈칸/비정상 → 생략(컨트롤플레인 기본 사용)
    // 부분 실행 — limit(앞 N개)/tags(쉼표 구분). 둘 다 비면 전체 실행(cases 생략).
    const limit = Number.parseInt(caseLimit, 10)
    const tags = caseTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const cases = {
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    }
    const res = await runScorecardAction({
      ...rest,
      ...(Number.isFinite(n) && n > 0 ? { concurrency: n } : {}),
      ...(Object.keys(cases).length > 0 ? { cases } : {}),
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

      {/* 부분 실행 — 전체 대신 케이스 일부만(비용/스모크). 결과엔 "일부 n/N" 표식이 남는다. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label htmlFor="caseLimit">케이스 수 제한 (선택)</Label>
            <InfoTip content="전체 대신 앞에서 N개만 평가해요. 비워두면 전체를 실행해요. 결과에 '일부 n/N' 표식이 남아요." />
          </div>
          <Input
            id="caseLimit"
            type="number"
            min={1}
            placeholder="예: 10"
            {...register('caseLimit')}
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label htmlFor="caseTags">태그 필터 (선택)</Label>
            <InfoTip content="이 태그가 있는 케이스만 평가해요(쉼표로 여러 개, 하나라도 일치하면 포함)." />
          </div>
          <Input id="caseTags" placeholder="예: easy, smoke" {...register('caseTags')} />
        </div>
      </div>

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <p className="text-[12px] text-muted-foreground">
        벤치마크의 모든 케이스를 이 하니스로 평가해 점수를 모아요. 실행이 끝나면 상세 화면에서
        결과를 확인해요.
      </p>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? '실행 중…' : '스코어카드 실행'}
      </Button>
    </form>
  )
}
