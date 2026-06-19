'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useForm } from 'react-hook-form'

import { Button } from '@/shared/ui/button'
import { FieldError, Input, Label, Select } from '@/shared/ui/input'
import { runScorecardAction } from '../api/run-scorecard'

interface Values {
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  runtime: string
}

// 데이터셋×하니스를 골라 배치 평가를 실행 + 적용할 judge + 실행 런타임 선택. 실제 해석은 컨트롤플레인이 한다.
export function RunScorecardForm({
  datasets,
  harnesses,
  judges,
  runtimes,
}: {
  datasets: { id: string }[]
  harnesses: { id: string }[]
  judges: { id: string }[]
  runtimes: { id: string }[]
}) {
  const router = useRouter()
  const [serverError, setServerError] = useState<string>()
  const [judgeIds, setJudgeIds] = useState<string[]>([])
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    defaultValues: {
      datasetId: datasets[0]?.id ?? '',
      datasetVersion: 'latest',
      harnessId: harnesses[0]?.id ?? 'scripted',
      harnessVersion: 'latest',
      runtime: '',
    },
  })

  async function onSubmit(values: Values) {
    setServerError(undefined)
    const res = await runScorecardAction({ ...values, judgeIds })
    if (res.ok && res.id) router.push(`/dashboard/scorecards/${res.id}`)
    else setServerError(res.error ?? '실행 실패')
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="datasetId">데이터셋</Label>
          <Input
            id="datasetId"
            list="dataset-ids"
            placeholder="repo-smoke"
            {...register('datasetId', { required: '데이터셋 id 를 입력하세요' })}
          />
          <datalist id="dataset-ids">
            {datasets.map((d) => (
              <option key={d.id} value={d.id} />
            ))}
          </datalist>
          <FieldError message={errors.datasetId?.message} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="datasetVersion">버전</Label>
          <Input id="datasetVersion" placeholder="latest" {...register('datasetVersion')} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="harnessId">하니스</Label>
          <Input
            id="harnessId"
            list="harness-ids"
            placeholder="scripted"
            {...register('harnessId', { required: '하니스 id 를 입력하세요' })}
          />
          <datalist id="harness-ids">
            {harnesses.map((h) => (
              <option key={h.id} value={h.id} />
            ))}
          </datalist>
          <FieldError message={errors.harnessId?.message} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="harnessVersion">버전</Label>
          <Input id="harnessVersion" placeholder="latest" {...register('harnessVersion')} />
        </div>
      </div>

      {judges.length > 0 && (
        <div className="space-y-1.5">
          <Label>Agent Judge (선택 — 트레이스에 적용)</Label>
          <div className="flex flex-wrap gap-3 rounded-xl border p-3 text-sm">
            {judges.map((j) => (
              <label key={j.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={judgeIds.includes(j.id)}
                  onChange={(e) => setJudgeIds(e.target.checked ? [...judgeIds, j.id] : judgeIds.filter((x) => x !== j.id))}
                />
                {j.id}
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
        </Select>
      </div>

      {serverError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {serverError}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        데이터셋의 모든 케이스를 이 하니스@버전으로 돌려 스코어카드를 집계합니다. 실행은 비동기 — 완료되면 상세에서 결과를 확인하세요.
      </p>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? '실행 중…' : '스코어카드 실행'}
      </Button>
    </form>
  )
}
