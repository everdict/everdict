'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Controller, useForm } from 'react-hook-form'

import type { Harness } from '@/entities/harness'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { FieldError, Input, Label, Textarea } from '@/shared/ui/input'

import { submitRunAction } from '../api/submit-run'

interface Values {
  harnessId: string
  version: string
  task: string
  runtime: string
  sourceKind: 'files' | 'git'
  gitUrl: string
  gitRef: string
}

export function SubmitRunForm({
  harnesses,
  runtimes = [],
  runners = [],
  hasWorkspaceRunners = false,
}: {
  harnesses: Harness[]
  runtimes?: { id: string }[]
  runners?: { id: string; label: string }[]
  hasWorkspaceRunners?: boolean // 팀 공유 러너가 있으면 self:ws 풀 옵션 노출
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [serverError, setServerError] = useState<string>()
  const {
    control,
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    defaultValues: {
      harnessId: harnesses[0]?.id ?? 'scripted',
      version: 'latest',
      task: '',
      runtime: '',
      sourceKind: 'files',
      gitUrl: '',
      gitRef: 'main',
    },
  })
  const sourceKind = watch('sourceKind')

  async function onSubmit(values: Values) {
    setServerError(undefined)
    const res = await submitRunAction(values)
    if (res.ok && res.id) router.push(`/${workspace}/runs/${res.id}`)
    else setServerError(res.error ?? '실행하지 못했어요')
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="harnessId">하니스</Label>
        <Controller
          control={control}
          name="harnessId"
          rules={{ required: '하니스를 골라주세요' }}
          render={({ field }) => (
            <Combobox
              id="harnessId"
              options={harnesses.map((h) => ({ value: h.id }))}
              value={field.value}
              onChange={field.onChange}
              placeholder="하니스 선택"
              emptyText="하니스가 없어요"
            />
          )}
        />
        <FieldError message={errors.harnessId?.message} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="version">버전</Label>
        <Input id="version" placeholder="latest" {...register('version')} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="task">작업</Label>
        <Textarea
          id="task"
          placeholder="예: create ok.txt with the text done"
          {...register('task', { required: '작업을 입력해주세요' })}
        />
        <FieldError message={errors.task?.message} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="runtime">런타임</Label>
        {/* optgroup 대응 — 내 로컬 러너는 우측 hint 로 구분(flat 리스트) */}
        <Controller
          control={control}
          name="runtime"
          render={({ field }) => (
            <Combobox
              id="runtime"
              options={[
                { value: '', label: '기본 실행 환경' },
                ...runtimes.map((r) => ({ value: r.id })),
                // 팀 공유 러너 풀 — 등록된 팀 러너 중 아무거나(capability 충족) 가져간다(멀티러너=동시성).
                ...(hasWorkspaceRunners
                  ? [{ value: 'self:ws', label: '팀 공유 러너 (아무거나)', hint: '팀' }]
                  : []),
                // 내 러너 풀 — 내 러너(여러 대일 수 있음) 중 아무거나. 특정 러너는 아래 개별 항목.
                ...(runners.length > 0
                  ? [{ value: 'self', label: '내 러너 (아무거나)', hint: '내 컴퓨터' }]
                  : []),
                ...runners.map((r) => ({
                  value: `self:${r.id}`,
                  label: r.label,
                  hint: '내 컴퓨터',
                })),
              ]}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        <p className="text-[12px] text-faint">
          비워두면 기본 환경에서 실행돼요. 등록한 런타임이나 내 컴퓨터를 고르면 그곳에서 실행돼요.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sourceKind">작업 폴더</Label>
        <Controller
          control={control}
          name="sourceKind"
          render={({ field }) => (
            <Combobox
              id="sourceKind"
              options={[
                { value: 'files', label: '빈 폴더' },
                { value: 'git', label: 'Git 저장소' },
              ]}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
      </div>

      {sourceKind === 'git' && (
        <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
          <div className="space-y-1.5">
            <Label htmlFor="gitUrl">Git URL</Label>
            <Input
              id="gitUrl"
              placeholder="https://github.com/acme/repo.git"
              {...register('gitUrl', {
                validate: (v) =>
                  sourceKind !== 'git' || v.trim().length > 0 || 'Git 주소를 입력해주세요',
              })}
            />
            <FieldError message={errors.gitUrl?.message} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gitRef">브랜치</Label>
            <Input id="gitRef" placeholder="main" {...register('gitRef')} />
          </div>
          <p className="text-[12px] text-faint">
            비공개 저장소는 워크스페이스 GitHub App 이 그 저장소에 설치돼 있으면 자동으로 인증해
            내려받아요(설정 › 통합). 공개 저장소는 바로 실행할 수 있어요.
          </p>
        </div>
      )}

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? '실행하는 중…' : '실행하기'}
      </Button>
    </form>
  )
}
