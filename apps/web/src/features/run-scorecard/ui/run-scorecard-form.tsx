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
  runtime: string // 실행 위치(등록 런타임 id 또는 self 러너 타깃). 컨트롤플레인이 미지정 배치를 400 — 필수.
  concurrency: string // 병렬도(빈칸=컨트롤플레인 기본). 제출 시 숫자로 파싱.
  caseLimit: string // 부분 실행 — 앞에서 N개만(빈칸=전체). 제출 시 숫자로 파싱.
  caseTags: string // 부분 실행 — 태그 필터(쉼표 구분, any-match. 빈칸=전체)
}

// 벤치마크 × 하니스를 골라 배치 평가를 실행한다. 채점은 벤치마크에 내장 — judge 는 컨트롤플레인 기본값.
export function RunScorecardForm({
  datasets,
  harnesses,
  runtimes = [],
  runners = [],
  hasWorkspaceRunners = false,
}: {
  datasets: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[]
  harnesses: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[]
  runtimes?: { id: string }[]
  runners?: { id: string; label: string }[]
  hasWorkspaceRunners?: boolean // 팀 공유 러너가 있으면 self:ws 풀 옵션 노출
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const t = useTranslations('runScorecard')
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
      runtime: '',
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
    hint: t('versionCountHint', { count: d.versions.length }),
  }))
  const harnessIdOptions: ComboboxOption[] = harnesses.map((h) => ({
    value: h.id,
    hint: t('versionCountHint', { count: h.versions.length }),
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
    else setServerError(res.error ?? t('submitError'))
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-4">
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
                  setValue('datasetVersion', 'latest') // id 바뀌면 버전은 latest 로 리셋(이전 버전이 새 id 엔 없을 수 있음).
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

      <div className="space-y-1.5">
        <Label htmlFor="runtime">{t('runtimeLabel')}</Label>
        {/* 실행 위치는 필수 — 컨트롤플레인 호스트 폴백이 금지돼(requireRuntime) 미지정 배치는 400. run 폼과 동일 선택지. */}
        <Controller
          control={control}
          name="runtime"
          rules={{ required: t('runtimeRequired') }}
          render={({ field }) => (
            <Combobox
              id="runtime"
              options={[
                ...runtimes.map((r) => ({ value: r.id })),
                // 팀 공유 러너 풀 — 등록된 팀 러너 중 아무거나(capability 충족) 가져간다(멀티러너=동시성).
                ...(hasWorkspaceRunners
                  ? [
                      {
                        value: 'self:ws',
                        label: t('poolWorkspaceLabel'),
                        hint: t('poolWorkspaceHint'),
                      },
                    ]
                  : []),
                // 내 러너 풀 — 내 러너(여러 대일 수 있음) 중 아무거나. 특정 러너는 아래 개별 항목.
                ...(runners.length > 0
                  ? [{ value: 'self', label: t('poolSelfLabel'), hint: t('poolSelfHint') }]
                  : []),
                ...runners.map((r) => ({
                  value: `self:${r.id}`,
                  label: r.label,
                  hint: t('poolSelfHint'),
                })),
              ]}
              value={field.value}
              onChange={field.onChange}
              placeholder={t('runtimePlaceholder')}
              emptyText={t('runtimeEmpty')}
            />
          )}
        />
        <FieldError message={errors.runtime?.message} />
        <p className="text-[12px] text-muted-foreground">{t('runtimeHelp')}</p>
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
        <p className="text-[12px] text-muted-foreground">{t('concurrencyHelp')}</p>
      </div>

      {/* 부분 실행 — 전체 대신 케이스 일부만(비용/스모크). 결과엔 "일부 n/N" 표식이 남는다. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label htmlFor="caseLimit">{t('caseLimitLabel')}</Label>
            <InfoTip content={t('caseLimitTip')} />
          </div>
          <Input
            id="caseLimit"
            type="number"
            min={1}
            placeholder={t('caseLimitPlaceholder')}
            {...register('caseLimit')}
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label htmlFor="caseTags">{t('caseTagsLabel')}</Label>
            <InfoTip content={t('caseTagsTip')} />
          </div>
          <Input id="caseTags" placeholder={t('caseTagsPlaceholder')} {...register('caseTags')} />
        </div>
      </div>

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <p className="text-[12px] text-muted-foreground">{t('help')}</p>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
