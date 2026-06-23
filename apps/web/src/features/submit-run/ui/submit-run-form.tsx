'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'

import type { ConnectionMeta } from '@/entities/connection'
import type { Harness } from '@/entities/harness'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { FieldError, Input, Label, Textarea } from '@/shared/ui/input'

import { submitRunAction } from '../api/submit-run'

interface Values {
  harnessId: string
  version: string
  task: string
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
}: {
  harnesses: Harness[]
  connections?: ConnectionMeta[]
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [serverError, setServerError] = useState<string>()
  const gitConnections = connections.filter(
    (c) => c.provider === 'github' || c.provider === 'github-enterprise'
  )
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    defaultValues: {
      harnessId: harnesses[0]?.id ?? 'scripted',
      version: 'latest',
      task: '',
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
        <Label htmlFor="sourceKind">작업트리(repo 시드)</Label>
        <select
          id="sourceKind"
          className="h-9 w-full rounded-md border bg-background px-3 text-[13px]"
          {...register('sourceKind')}
        >
          <option value="files">빈 작업트리</option>
          <option value="git">Git repo (URL)</option>
        </select>
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
            <select
              id="connectionId"
              className="h-9 w-full rounded-md border bg-background px-3 text-[13px]"
              {...register('connectionId')}
            >
              <option value="">없음 (public repo)</option>
              {gitConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {providerLabel(c)}
                </option>
              ))}
            </select>
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
