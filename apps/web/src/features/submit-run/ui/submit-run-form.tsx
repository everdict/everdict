'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useForm } from 'react-hook-form'

import type { Harness } from '@/entities/harness'
import { Button } from '@/shared/ui/button'
import { FieldError, Input, Label, Textarea } from '@/shared/ui/input'
import { submitRunAction } from '../api/submit-run'

interface Values {
  harnessId: string
  version: string
  task: string
}

export function SubmitRunForm({ harnesses }: { harnesses: Harness[] }) {
  const router = useRouter()
  const [serverError, setServerError] = useState<string>()
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    defaultValues: { harnessId: harnesses[0]?.id ?? 'scripted', version: 'latest', task: '' },
  })

  async function onSubmit(values: Values) {
    setServerError(undefined)
    const res = await submitRunAction(values)
    if (res.ok && res.id) router.push(`/dashboard/runs/${res.id}`)
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

      {serverError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {serverError}
        </div>
      )}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? '제출 중…' : 'run 제출'}
      </Button>
    </form>
  )
}
