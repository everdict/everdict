'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Play, Telescope, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Controller, useForm } from 'react-hook-form'

import { CapabilityBadge, capabilityFit, CapabilityFitNote } from '@/entities/runtime'
import type { TraceSourceConfig } from '@/entities/trace-source'
import { cn } from '@/shared/lib/utils'
import { versionOptions } from '@/shared/lib/version-options'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'
import { FieldError, Input, Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import { createScheduleAction, type CreateScheduleInput } from '../api/create-schedule'
import { updateScheduleAction } from '../api/update-schedule'

// cron presets — common cadences in one click instead of raw entry. Direct editing is also possible (input below).
const CRON_PRESETS: { labelKey: string; value: string }[] = [
  { labelKey: 'presetHourly', value: '0 * * * *' },
  { labelKey: 'presetMidnight', value: '0 0 * * *' },
  { labelKey: 'presetDaily3am', value: '0 3 * * *' },
  { labelKey: 'presetWeekdays9am', value: '0 9 * * 1-5' },
  { labelKey: 'presetMonday9', value: '0 9 * * 1' },
]

type ScheduleMode = 'batch' | 'pull'

interface Values {
  mode: ScheduleMode // batch (dataset×harness run) | pull (judge a rolling window of a trace source)
  name: string
  cron: string
  timezone: string
  overlapPolicy: string
  datasetId: string
  datasetVersion: string
  harnessId: string
  harnessVersion: string
  judgeIds: string[] // Agent Judges to score each fire's traces → judge:<id> metrics (empty = control-plane default scoring).
  runtime: string
  concurrency: string
  trials: string // pass@k / flakiness — run each case N times per fire (empty = 1). Parsed on submit.
  caseLimit: string // partial run — only the first N (empty = all). Parsed on submit.
  caseTags: string // partial run — tag filter (comma-separated, any-match; empty = all)
  // pull mode
  pullSource: string // a registered trace source name
  pullScope: string // platform scope (experiment/project/service) — optional
  pullWindowHours: string // rolling lookback in hours (parsed on submit; default 24)
}

// Create/edit a schedule that runs dataset×harness periodically via cron. Firing/interpretation is done by the control plane (Temporal Schedule).
// If scheduleId is present, it's edit mode (PATCH) — prefill from initial + initialJudges. The firing run mirrors a one-off scorecard's config.
export function CreateScheduleForm({
  datasets,
  harnesses,
  runtimes,
  judges = [],
  runners = [],
  hasWorkspaceRunners = false,
  traceSources = [],
  initial,
  scheduleId,
  initialJudges = [],
}: {
  datasets: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[]
  // kind drives the runtime capability-fit preview (a service harness needs a container runtime).
  harnesses: {
    id: string
    versions: string[]
    versionTags?: Record<string, string[]>
    kind?: string
  }[]
  runtimes: { id: string; capabilities?: string[] }[]
  judges?: { id: string }[]
  runners?: { id: string; label: string }[]
  hasWorkspaceRunners?: boolean // Expose the self:ws pool option when team shared runners exist
  traceSources?: TraceSourceConfig[] // registered observability sources — enable the "evaluate traces" (pull) mode
  initial?: Partial<Values>
  scheduleId?: string
  initialJudges?: { id: string; version: string }[]
}) {
  const t = useTranslations('createSchedule')
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
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
      mode: 'batch',
      name: '',
      cron: '0 3 * * *',
      timezone: 'UTC',
      overlapPolicy: 'skip',
      datasetId: datasets[0]?.id ?? '',
      datasetVersion: 'latest',
      harnessId: harnesses[0]?.id ?? 'scripted',
      harnessVersion: 'latest',
      judgeIds: initialJudges.map((j) => j.id),
      runtime: '',
      concurrency: '',
      trials: '',
      caseLimit: '',
      caseTags: '',
      pullSource: traceSources[0]?.name ?? '',
      pullScope: '',
      pullWindowHours: '24',
      ...initial,
    },
  })

  const mode = watch('mode')
  const datasetId = watch('datasetId')
  const harnessId = watch('harnessId')
  const cron = watch('cron')
  const datasetIdOptions: ComboboxOption[] = datasets.map((d) => ({
    value: d.id,
    hint: t('versionsCount', { count: d.versions.length }),
  }))
  const harnessIdOptions: ComboboxOption[] = harnesses.map((h) => ({
    value: h.id,
    hint: t('versionsCount', { count: h.versions.length }),
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
    // Selected judges → the API's judges:[{id,version}] (version latest). Shared by both modes.
    const judges = values.judgeIds.map((id) => ({ id, version: 'latest' }))
    const shared = {
      name: values.name,
      cron: values.cron,
      timezone: values.timezone,
      overlapPolicy: values.overlapPolicy,
      judges,
    }
    let input: CreateScheduleInput
    if (values.mode === 'pull') {
      const wh = Number.parseInt(values.pullWindowHours, 10)
      input = {
        ...shared,
        pull: {
          source: values.pullSource,
          ...(values.pullScope.trim() ? { scope: values.pullScope.trim() } : {}),
          windowHours: Number.isFinite(wh) && wh > 0 ? wh : 24,
        },
      }
    } else {
      const n = Number.parseInt(values.concurrency, 10)
      const tn = Number.parseInt(values.trials, 10)
      const limit = Number.parseInt(values.caseLimit, 10)
      const tags = values.caseTags
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
      const cases = {
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      }
      input = {
        ...shared,
        datasetId: values.datasetId,
        datasetVersion: values.datasetVersion,
        harnessId: values.harnessId,
        harnessVersion: values.harnessVersion,
        runtime: values.runtime,
        ...(Number.isFinite(n) && n > 0 ? { concurrency: n } : {}),
        ...(Number.isFinite(tn) && tn > 1 ? { trials: tn } : {}),
        ...(Object.keys(cases).length > 0 ? { cases } : {}),
      }
    }
    const res = scheduleId
      ? await updateScheduleAction(scheduleId, input)
      : await createScheduleAction(input)
    if (res.ok) router.push(`/${workspace}/schedules`)
    else setServerError(res.error ?? (scheduleId ? t('updateFailed') : t('createFailed')))
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">{t('nameLabel')}</Label>
        <Input
          id="name"
          placeholder="nightly-regression"
          {...register('name', { required: t('nameRequired') })}
        />
        <FieldError message={errors.name?.message} />
      </div>

      {/* What each fire produces: a batch run (dataset×harness) or a trace evaluation (judge a rolling window of a
          trace source). Judging + cron/timezone/overlap are shared; only the "what" differs. */}
      <div className="space-y-1.5">
        <Label>{t('modeLabel')}</Label>
        <Controller
          control={control}
          name="mode"
          render={({ field }) => (
            <div className="inline-flex rounded-lg border border-border bg-secondary/40 p-1 text-[13px]">
              {(
                [
                  { m: 'batch' as const, label: t('modeBatch'), icon: Play },
                  { m: 'pull' as const, label: t('modeTraces'), icon: Telescope },
                ] satisfies { m: ScheduleMode; label: string; icon: typeof Play }[]
              ).map(({ m, label, icon: Icon }) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => field.onChange(m)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 font-[510] transition-colors',
                    field.value === m
                      ? 'bg-card text-foreground shadow-raise'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              ))}
            </div>
          )}
        />
        <p className="text-[12px] text-muted-foreground">
          {mode === 'pull' ? t('modeTracesHint') : t('modeBatchHint')}
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {CRON_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => setValue('cron', p.value, { shouldValidate: true })}
            className={`rounded-md border px-2.5 py-1 text-[12px] font-[510] transition-colors ${
              cron === p.value
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground'
            }`}
          >
            {t(p.labelKey)}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="cron">{t('cronLabel')}</Label>
          <Input
            id="cron"
            placeholder="0 3 * * *"
            className="font-mono"
            {...register('cron', {
              required: t('cronRequired'),
              pattern: {
                value:
                  /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*(\s+(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*){4}$/,
                message: t('cronPattern'),
              },
            })}
          />
          <FieldError message={errors.cron?.message} />
          <p className="text-[12px] text-muted-foreground">{t('cronHint')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="timezone">{t('timezoneLabel')}</Label>
          <Input id="timezone" placeholder="UTC" {...register('timezone')} />
          <p className="text-[12px] text-muted-foreground">{t('timezoneHint')}</p>
        </div>
      </div>

      {mode === 'batch' ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="datasetId">{t('datasetLabel')}</Label>
              <Controller
                control={control}
                name="datasetId"
                rules={{ required: mode === 'batch' ? t('datasetRequired') : false }}
                render={({ field }) => (
                  <Combobox
                    id="datasetId"
                    options={datasetIdOptions}
                    value={field.value}
                    onChange={(v) => {
                      field.onChange(v)
                      setValue('datasetVersion', 'latest')
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
                rules={{ required: mode === 'batch' ? t('harnessRequired') : false }}
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
        </>
      ) : (
        <>
          {/* Trace evaluation — pick a registered source + a rolling window; each fire judges that window's traces. */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="pullSource">{t('pullSourceLabel')}</Label>
              <Controller
                control={control}
                name="pullSource"
                rules={{ required: mode === 'pull' ? t('pullSourceRequired') : false }}
                render={({ field }) => (
                  <Combobox
                    id="pullSource"
                    options={traceSources.map((s) => ({
                      value: s.name,
                      label: s.name,
                      hint: s.kind,
                    }))}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder={t('pullSourcePlaceholder')}
                    emptyText={t('pullSourceEmpty')}
                  />
                )}
              />
              <FieldError message={errors.pullSource?.message} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-1">
                <Label htmlFor="pullWindowHours">{t('pullWindowLabel')}</Label>
                <InfoTip content={t('pullWindowTip')} />
              </div>
              <Input
                id="pullWindowHours"
                type="number"
                min={1}
                max={720}
                placeholder="24"
                {...register('pullWindowHours')}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="pullScope">{t('pullScopeLabel')}</Label>
              <InfoTip content={t('pullScopeTip')} />
            </div>
            <Input
              id="pullScope"
              placeholder={t('pullScopePlaceholder')}
              {...register('pullScope')}
            />
          </div>
        </>
      )}

      {/* Agent Judges (optional) — model/harness judges that score each fire's traces; each pick aggregates as a judge:<id> metric. */}
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
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="overlapPolicy">{t('overlapLabel')}</Label>
          <Controller
            control={control}
            name="overlapPolicy"
            render={({ field }) => (
              <Combobox
                id="overlapPolicy"
                options={[
                  { value: 'skip', label: t('overlapSkip') },
                  { value: 'bufferOne', label: t('overlapBufferOne') },
                  { value: 'allowAll', label: t('overlapAllowAll') },
                ]}
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </div>
        {mode === 'batch' && (
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
          </div>
        )}
      </div>

      {mode === 'batch' && (
        <>
          {/* Trials + partial run — same knobs as a one-off scorecard, so a nightly regression can pass@k / smoke-run a subset. */}
          <div className="grid grid-cols-3 gap-3">
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
              <Input
                id="caseTags"
                placeholder={t('caseTagsPlaceholder')}
                {...register('caseTags')}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="runtime">{t('runtimeLabel')}</Label>
            {/* Runtime is required — the control-plane host fallback is disallowed (requireRuntime), so a schedule with no runtime fails 400 on every firing. Same options as the scorecard form. */}
            <Controller
              control={control}
              name="runtime"
              rules={{ required: mode === 'batch' ? t('runtimeRequired') : false }}
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
                      // Team shared runner pool.
                      ...(hasWorkspaceRunners
                        ? [
                            {
                              value: 'self:ws',
                              label: t('poolWorkspaceLabel'),
                              hint: t('poolWorkspaceHint'),
                            },
                          ]
                        : []),
                      // My runner pool + specific runners.
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
            <p className="text-[12px] text-muted-foreground">{t('runtimeHint')}</p>
          </div>
        </>
      )}

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <p className="text-[12px] text-muted-foreground">{t('footerNote')}</p>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting
          ? scheduleId
            ? t('saving')
            : t('creating')
          : scheduleId
            ? t('saveChanges')
            : t('createSchedule')}
      </Button>
    </form>
  )
}
