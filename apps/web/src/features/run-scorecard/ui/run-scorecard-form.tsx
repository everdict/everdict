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

// Version options — 'latest' alias (at top, with the resolved result + tags as hint) + registered versions (newest semver first, tags as hint when present).
// versionTags = version → free-form label (only versions that have tags). Identify versions that are hard to tell apart by number alone via their tags.
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
  runtime: string // Execution location (registered runtime id or self runner target). The control plane 400s an unspecified placement — required.
  concurrency: string // Parallelism (empty = control plane default). Parsed to a number on submit.
  trials: string // Run each case N times for pass@k / flakiness (empty = 1). Parsed to a number on submit.
  caseLimit: string // Partial run — only the first N (empty = all). Parsed to a number on submit.
  caseTags: string // Partial run — tag filter (comma-separated, any-match; empty = all)
}

// Pick a benchmark × harness and run a batch evaluation. Scoring is built into the benchmark — judge defaults to the control plane default.
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
  hasWorkspaceRunners?: boolean // Expose the self:ws pool option when team shared runners exist
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
      trials: '',
      caseLimit: '',
      caseTags: '',
    },
  })

  // Narrow the version options by the selected id (versions already come with the list — no extra request).
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
    const { concurrency, trials, caseLimit, caseTags, ...rest } = values
    const n = Number.parseInt(concurrency, 10) // empty/invalid → omit (use control plane default)
    const tn = Number.parseInt(trials, 10) // empty/invalid → omit (1 trial)
    // Partial run — limit (first N) / tags (comma-separated). If both are empty, run all (omit cases).
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
      ...(Number.isFinite(tn) && tn > 1 ? { trials: tn } : {}),
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
                  setValue('datasetVersion', 'latest') // reset version to latest when the id changes (the previous version may not exist for the new id).
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
        {/* Execution location is required — the control plane host fallback is disabled (requireRuntime), so an unspecified placement 400s. Same options as the run form. */}
        <Controller
          control={control}
          name="runtime"
          rules={{ required: t('runtimeRequired') }}
          render={({ field }) => (
            <Combobox
              id="runtime"
              options={[
                ...runtimes.map((r) => ({ value: r.id })),
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

      {/* Trials — run each case N times for pass@k / flakiness (empty/1 = single run). */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="trials">{t('trialsLabel')}</Label>
          <InfoTip content={t('trialsTip')} />
        </div>
        <Input
          id="trials"
          type="number"
          min={1}
          max={100}
          placeholder={t('trialsPlaceholder')}
          {...register('trials')}
        />
      </div>

      {/* Partial run — only a subset of cases instead of all (cost/smoke). The result keeps a "partial n/N" marker. */}
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
