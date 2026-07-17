'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Controller, useForm } from 'react-hook-form'

import { CapabilityBadge, capabilityFit, CapabilityFitNote } from '@/entities/runtime'
import { versionOptions } from '@/shared/lib/version-options'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'
import { FieldError, Input, Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import { runScorecardAction } from '../api/run-scorecard'

interface Values {
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  judgeIds: string[] // Optional Agent Judges to score each case's trace → judge:<id> metrics (empty = control-plane default scoring).
  runtime: string // Execution location (registered runtime id or self runner target). The control plane 400s an unspecified placement — required.
  concurrency: string // Parallelism (empty = control plane default). Parsed to a number on submit.
  trials: string // Run each case N times for pass@k / flakiness (empty = 1). Parsed to a number on submit.
  caseIds: string // Partial run — explicit case ids (comma/space-separated; e.g. re-run the failing ones). Empty = not filtered by id.
  caseLimit: string // Partial run — only the first N (empty = all). Parsed to a number on submit.
  caseTags: string // Partial run — tag filter (comma-separated, any-match; empty = all)
}

// Pick a harness × dataset × judge(s) and run a batch evaluation. The selected judges score each case's trace → their
// scores aggregate as judge:<id> metrics (mean + pass-rate) alongside the dataset's own graders on the detail page.
export function RunScorecardForm({
  datasets,
  harnesses,
  judges = [],
  runtimes = [],
  runners = [],
  hasWorkspaceRunners = false,
}: {
  datasets: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[]
  // kind drives the submit-time capability-fit preview against each runtime (a service harness needs a container runtime).
  harnesses: {
    id: string
    versions: string[]
    versionTags?: Record<string, string[]>
    kind?: string
  }[]
  judges?: { id: string }[] // Registered Agent Judges (model|harness) selectable to score each case
  runtimes?: { id: string; capabilities?: string[] }[] // capabilities = latest version's declared caps (for fit preview)
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
      judgeIds: [],
      runtime: '',
      concurrency: '',
      trials: '',
      caseIds: '',
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
  // Drives the runtime capability-fit preview (a service/topology harness needs a container-capable runtime).
  const harnessKind = harnessEntry?.kind
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
    const { concurrency, trials, caseIds, caseLimit, caseTags, judgeIds, ...rest } = values
    // Selected judges → the API's judges:[{id,version}] (version latest); omitted when none picked.
    const judgeRefs = judgeIds.map((id) => ({ id, version: 'latest' }))
    const n = Number.parseInt(concurrency, 10) // empty/invalid → omit (use control plane default)
    const tn = Number.parseInt(trials, 10) // empty/invalid → omit (1 trial)
    // Partial run — ids (explicit, split on comma/space) → tags (any-match) → limit (first N). All empty = run all (omit cases).
    const limit = Number.parseInt(caseLimit, 10)
    const ids = caseIds.split(/[\s,]+/).filter(Boolean)
    const tags = caseTags
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    const cases = {
      ...(ids.length > 0 ? { ids } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    }
    const res = await runScorecardAction({
      ...rest,
      ...(judgeRefs.length > 0 ? { judges: judgeRefs } : {}),
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

      {/* Agent Judges (optional) — model/harness judges that score each case's trace; each pick aggregates as a judge:<id> metric. */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="judges">{t('judgesLabel')}</Label>
          <InfoTip content={t('judgesTip')} />
        </div>
        <Controller
          control={control}
          name="judgeIds"
          render={({ field }) => {
            const available = judges
              .filter((j) => !field.value.includes(j.id))
              .map((j) => ({ value: j.id }))
            return (
              <div className="space-y-2">
                <Combobox
                  id="judges"
                  options={available}
                  value=""
                  onChange={(v) => {
                    if (v && !field.value.includes(v)) field.onChange([...field.value, v])
                  }}
                  placeholder={t('judgesPlaceholder')}
                  emptyText={t('judgesEmpty')}
                />
                {field.value.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {field.value.map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 font-mono text-[12px] font-[510] text-secondary-foreground ring-1 ring-inset ring-border"
                      >
                        {id}
                        <button
                          type="button"
                          aria-label={t('judgesRemove', { id })}
                          onClick={() => field.onChange(field.value.filter((x) => x !== id))}
                          className="text-faint transition-colors hover:text-destructive"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          }}
        />
        <p className="text-[12px] text-muted-foreground">{t('judgesHelp')}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="runtime">{t('runtimeLabel')}</Label>
        {/* Execution location is required — the control plane host fallback is disabled (requireRuntime), so an unspecified placement 400s. Same options as the run form. */}
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
      <div className="space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label htmlFor="caseIds">{t('caseIdsLabel')}</Label>
            <InfoTip content={t('caseIdsTip')} />
          </div>
          <Input id="caseIds" placeholder={t('caseIdsPlaceholder')} {...register('caseIds')} />
        </div>
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
      </div>

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <p className="text-[12px] text-muted-foreground">{t('help')}</p>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
