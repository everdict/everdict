'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Controller, useForm } from 'react-hook-form'

import type { Harness } from '@/entities/harness'
import { CapabilityBadge, capabilityFit, CapabilityFitNote } from '@/entities/runtime'
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
  runtimes?: { id: string; capabilities?: string[] }[] // capabilities = latest version's declared caps (for fit preview)
  runners?: { id: string; label: string }[]
  hasWorkspaceRunners?: boolean // Expose the self:ws pool option when team shared runners exist
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
  // Drives the runtime capability-fit preview (a service/topology harness needs a container-capable runtime).
  const harnessKind = harnesses.find((h) => h.id === watch('harnessId'))?.kind

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
        {/* optgroup stand-in — my local runners are distinguished by the right-side hint (flat list) */}
        {/* Execution location is required — the control plane host fallback is disabled (requireRuntime), so an unspecified run 400s. */}
        <Controller
          control={control}
          name="runtime"
          rules={{ required: t('runtimeRequired') }}
          render={({ field }) => (
            <>
              <Combobox
                id="runtime"
                options={[
                  // Registered runtimes — a capability-fit badge shows when there's a definite verdict for this harness.
                  ...runtimes.map((r) => {
                    const fit = capabilityFit(r.capabilities, harnessKind)
                    return {
                      value: r.id,
                      ...(fit === 'fit' || fit === 'unfit'
                        ? {
                            hint: (
                              <CapabilityBadge
                                harnessKind={harnessKind}
                                capabilities={r.capabilities}
                              />
                            ),
                          }
                        : {}),
                    }
                  }),
                  // Team shared runner pool — takes any registered team runner that meets capability (multiple runners = concurrency).
                  ...(hasWorkspaceRunners
                    ? [
                        {
                          value: 'self:ws',
                          label: t('poolWorkspaceLabel'),
                          hint: t('poolWorkspaceHint'),
                        },
                      ]
                    : []),
                  // My runner pool — any of my runners (there may be several). A specific runner is an individual item below.
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
              <CapabilityFitNote
                harnessKind={harnessKind}
                capabilities={runtimes.find((r) => r.id === field.value)?.capabilities}
              />
            </>
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
