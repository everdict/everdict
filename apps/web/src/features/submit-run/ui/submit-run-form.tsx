'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
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
  const t = useTranslations('submitRun')
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
    else setServerError(res.error ?? t('submitError'))
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="harnessId">{t('harnessLabel')}</Label>
        <Controller
          control={control}
          name="harnessId"
          rules={{ required: t('harnessRequired') }}
          render={({ field }) => (
            <Combobox
              id="harnessId"
              options={harnesses.map((h) => ({ value: h.id }))}
              value={field.value}
              onChange={field.onChange}
              placeholder={t('harnessPlaceholder')}
              emptyText={t('harnessEmpty')}
            />
          )}
        />
        <FieldError message={errors.harnessId?.message} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="version">{t('versionLabel')}</Label>
        <Input id="version" placeholder="latest" {...register('version')} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="task">{t('taskLabel')}</Label>
        <Textarea
          id="task"
          placeholder={t('taskPlaceholder')}
          {...register('task', { required: t('taskRequired') })}
        />
        <FieldError message={errors.task?.message} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="runtime">{t('runtimeLabel')}</Label>
        {/* optgroup 대응 — 내 로컬 러너는 우측 hint 로 구분(flat 리스트) */}
        {/* 실행 위치는 필수 — 컨트롤플레인 호스트 폴백이 금지돼(requireRuntime) 미지정 run 은 400. */}
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
        <p className="text-[12px] text-faint">{t('runtimeHelp')}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sourceKind">{t('sourceLabel')}</Label>
        <Controller
          control={control}
          name="sourceKind"
          render={({ field }) => (
            <Combobox
              id="sourceKind"
              options={[
                { value: 'files', label: t('sourceFiles') },
                { value: 'git', label: t('sourceGit') },
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
            <Label htmlFor="gitUrl">{t('gitUrlLabel')}</Label>
            <Input
              id="gitUrl"
              placeholder="https://github.com/acme/repo.git"
              {...register('gitUrl', {
                validate: (v) => sourceKind !== 'git' || v.trim().length > 0 || t('gitUrlRequired'),
              })}
            />
            <FieldError message={errors.gitUrl?.message} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gitRef">{t('branchLabel')}</Label>
            <Input id="gitRef" placeholder="main" {...register('gitRef')} />
          </div>
          <p className="text-[12px] text-faint">{t('gitHelp')}</p>
        </div>
      )}

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
