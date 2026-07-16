'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Controller, useForm } from 'react-hook-form'

import type { Harness } from '@/entities/harness'
import { CapabilityBadge, capabilityFit, CapabilityFitNote } from '@/entities/runtime'
import { versionOptions } from '@/shared/lib/version-options'
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
  timeoutMinutes: string // Per-run timeout (empty = the control-plane default of 30 min). Parsed to seconds on submit.
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
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    defaultValues: {
      harnessId: harnesses[0]?.id ?? 'scripted',
      version: 'latest',
      task: '',
      runtime: '',
      timeoutMinutes: '',
      sourceKind: 'files',
      gitUrl: '',
      gitRef: 'main',
    },
  })
  const sourceKind = watch('sourceKind')
  const harnessEntry = harnesses.find((h) => h.id === watch('harnessId'))
  // Drives the runtime capability-fit preview (a service/topology harness needs a container-capable runtime).
  const harnessKind = harnessEntry?.kind
  // Version picker options — the harness list already carries versions/tags (no extra request), same as the scorecard form.
  const harnessVersionOptions = versionOptions(harnessEntry?.versions ?? [], harnessEntry?.versionTags)

  async function onSubmit(values: Values) {
    setServerError(undefined)
    // Empty/invalid timeout → omit so the control plane applies the EvalCase default (1800s); otherwise minutes → seconds.
    const mins = Number.parseInt(values.timeoutMinutes, 10)
    const res = await submitRunAction({
      ...values,
      ...(Number.isFinite(mins) && mins > 0 ? { timeoutSec: mins * 60 } : {}),
    })
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
              onChange={(v) => {
                field.onChange(v)
                setValue('version', 'latest') // reset to latest when the harness changes (the prior version may not exist for the new id)
              }}
              placeholder={t('harnessPlaceholder')}
              emptyText={t('harnessEmpty')}
            />
          )}
        />
        <FieldError message={errors.harnessId?.message} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="version">{t('versionLabel')}</Label>
        <Controller
          control={control}
          name="version"
          render={({ field }) => (
            <Combobox
              id="version"
              options={harnessVersionOptions}
              value={field.value}
              onChange={field.onChange}
              searchable={false}
            />
          )}
        />
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

      {/* Per-run timeout — empty falls back to the control-plane default (30 min); a long agent case (many LLM calls) can raise it. */}
      <div className="space-y-1.5">
        <Label htmlFor="timeoutMinutes">{t('timeoutLabel')}</Label>
        <Input
          id="timeoutMinutes"
          type="number"
          min={1}
          placeholder={t('timeoutPlaceholder')}
          {...register('timeoutMinutes')}
        />
        <p className="text-[12px] text-faint">{t('timeoutHelp')}</p>
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
