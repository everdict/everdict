'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Controller, useForm } from 'react-hook-form'

import type { ConnectionMeta } from '@/entities/connection'
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
  connectionId: string
}

const providerLabel = (c: ConnectionMeta): string =>
  `${c.provider === 'github-enterprise' ? 'GHE' : 'GitHub'} · ${c.accountLabel}${c.host ? ` (${c.host})` : ''}`

// connections: repo clone 에 쓸 수 있는 건 git provider(github / github-enterprise)뿐 — Mattermost 등은 제외.
export function SubmitRunForm({
  harnesses,
  connections = [],
  runtimes = [],
  runners = [],
}: {
  harnesses: Harness[]
  connections?: ConnectionMeta[]
  runtimes?: { id: string }[]
  runners?: { id: string; label: string }[]
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [serverError, setServerError] = useState<string>()
  const gitConnections = connections.filter(
    (c) => c.provider === 'github' || c.provider === 'github-enterprise'
  )
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
      connectionId: '',
    },
  })
  const sourceKind = watch('sourceKind')

  async function onSubmit(values: Values) {
    setServerError(undefined)
    const res = await submitRunAction(values)
    if (res.ok && res.id) router.push(`/${workspace}/runs/${res.id}`)
    else setServerError(res.error ?? '제출 실패')
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="harnessId">하니스</Label>
        <Controller
          control={control}
          name="harnessId"
          rules={{ required: '하니스를 선택하세요' }}
          render={({ field }) => (
            <Combobox
              id="harnessId"
              options={harnesses.map((h) => ({ value: h.id }))}
              value={field.value}
              onChange={field.onChange}
              placeholder="하니스 선택"
              emptyText="하니스가 없습니다"
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
        <Label htmlFor="task">Task</Label>
        <Textarea
          id="task"
          placeholder="예: create ok.txt with the text done"
          {...register('task', { required: 'task 를 입력하세요' })}
        />
        <FieldError message={errors.task?.message} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="runtime">런타임 (실행 인프라)</Label>
        {/* optgroup 대응 — 내 로컬 러너는 우측 hint 로 구분(flat 리스트) */}
        <Controller
          control={control}
          name="runtime"
          render={({ field }) => (
            <Combobox
              id="runtime"
              options={[
                { value: '', label: '기본 백엔드' },
                ...runtimes.map((r) => ({ value: r.id })),
                ...runners.map((r) => ({
                  value: `self:${r.id}`,
                  label: r.label,
                  hint: '내 로컬 호스트',
                })),
              ]}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        <p className="text-[12px] text-faint">
          비워두면 기본 백엔드에서 실행됩니다. 등록한 런타임이나 내 로컬 러너를 고르면 그곳에서
          실행됩니다.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sourceKind">작업트리(repo 시드)</Label>
        <Controller
          control={control}
          name="sourceKind"
          render={({ field }) => (
            <Combobox
              id="sourceKind"
              options={[
                { value: 'files', label: '빈 작업트리' },
                { value: 'git', label: 'Git repo (URL)' },
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
                  sourceKind !== 'git' || v.trim().length > 0 || 'Git URL 을 입력하세요',
              })}
            />
            <FieldError message={errors.gitUrl?.message} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gitRef">Ref</Label>
            <Input id="gitRef" placeholder="main" {...register('gitRef')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="connectionId">연결된 계정 (비공개 repo 인증)</Label>
            <Controller
              control={control}
              name="connectionId"
              render={({ field }) => (
                <Combobox
                  id="connectionId"
                  options={[
                    { value: '', label: '없음 (public repo)' },
                    ...gitConnections.map((c) => ({ value: c.id, label: providerLabel(c) })),
                  ]}
                  value={field.value}
                  onChange={field.onChange}
                />
              )}
            />
            <p className="text-[12px] text-faint">
              {gitConnections.length === 0
                ? '연결된 GitHub 계정이 없습니다 — 비공개 repo 는 설정 → 연결된 계정에서 먼저 연결하세요(public 은 그대로 가능).'
                : '비공개 repo 면 연결을 고르세요. 토큰은 컨트롤플레인이 clone 시점에만 주입하며 화면/케이스에 저장되지 않습니다.'}
            </p>
          </div>
        </div>
      )}

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? '제출 중…' : 'run 제출'}
      </Button>
    </form>
  )
}
