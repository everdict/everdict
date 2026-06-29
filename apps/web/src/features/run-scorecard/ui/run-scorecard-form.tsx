'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Controller, useForm } from 'react-hook-form'

import { sortSemverDesc } from '@/shared/lib/semver'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'
import { FieldError, Input, Label, Select } from '@/shared/ui/input'

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
  runtime: string
  judgeModel: string
}

// 데이터셋×하니스를 골라 배치 평가를 실행 + 적용할 judge + 실행 런타임 선택. 실제 해석은 컨트롤플레인이 한다.
export function RunScorecardForm({
  datasets,
  harnesses,
  judges,
  metrics,
  runtimes,
  runners,
}: {
  datasets: { id: string; versions: string[] }[]
  harnesses: { id: string; versions: string[] }[]
  judges: { id: string }[]
  metrics: { id: string }[]
  runtimes: { id: string }[]
  runners: { id: string; label: string }[] // 내 셀프호스티드 러너 — self:<id> 로 선택(개인 소유)
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [serverError, setServerError] = useState<string>()
  const [judgeIds, setJudgeIds] = useState<string[]>([])
  const [metricIds, setMetricIds] = useState<string[]>([])
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
      judgeModel: '',
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
    const res = await runScorecardAction({ ...values, judgeIds, metricIds })
    if (res.ok && res.id) router.push(`/${workspace}/scorecards/${res.id}`)
    else setServerError(res.error ?? '실행 실패')
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-4">
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
                  setValue('datasetVersion', 'latest') // id 바뀌면 버전은 latest 로 리셋(이전 버전이 새 id 엔 없을 수 있음).
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

      {judges.length > 0 && (
        <div className="space-y-1.5">
          <Label>Agent Judge (선택 — 트레이스에 적용)</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border border-border bg-card p-3 text-[13px]">
            {judges.map((j) => (
              <label key={j.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={judgeIds.includes(j.id)}
                  onChange={(e) =>
                    setJudgeIds(
                      e.target.checked ? [...judgeIds, j.id] : judgeIds.filter((x) => x !== j.id)
                    )
                  }
                />
                {j.id}
              </label>
            ))}
          </div>
        </div>
      )}

      {metrics.length > 0 && (
        <div className="space-y-1.5">
          <Label>메트릭 (선택 — 결과 점수 위 합격규칙 적용)</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border border-border bg-card p-3 text-[13px]">
            {metrics.map((m) => (
              <label key={m.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={metricIds.includes(m.id)}
                  onChange={(e) =>
                    setMetricIds(
                      e.target.checked ? [...metricIds, m.id] : metricIds.filter((x) => x !== m.id)
                    )
                  }
                />
                {m.id}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="runtime">런타임 (실행 인프라)</Label>
        <Select id="runtime" {...register('runtime')}>
          <option value="">기본 백엔드</option>
          {runtimes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id}
            </option>
          ))}
          {runners.length > 0 && (
            <optgroup label="내 로컬 호스트">
              {runners.map((r) => (
                <option key={r.id} value={`self:${r.id}`}>
                  {r.label}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
        {runners.length > 0 && (
          <p className="text-[12px] text-muted-foreground">
            내 로컬 호스트를 고르면 워크스페이스의 공유 하니스·데이터셋을 내 머신에서(내 로그인·repo
            로) 돌리고 결과를 회신합니다. 내가 페어링한 러너만 보이며, 결과는 워크스페이스에
            기록됩니다.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="judgeModel">judge 모델 (선택 — inline judge grader)</Label>
        <Input id="judgeModel" placeholder="gpt-5.4-mini" {...register('judgeModel')} />
        <p className="text-[12px] text-muted-foreground">
          케이스의 judge grader(예: os-use 스크린샷 VLM 채점) 모델. 미지정이면 워크스페이스 기본
          judge 를 씁니다.
        </p>
      </div>

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <p className="text-[12px] text-muted-foreground">
        데이터셋의 모든 케이스를 이 하니스@버전으로 돌려 스코어카드를 집계합니다. 실행은 비동기 —
        완료되면 상세에서 결과를 확인하세요.
      </p>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? '실행 중…' : '스코어카드 실행'}
      </Button>
    </form>
  )
}
