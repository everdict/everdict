'use client'

import { useState, useTransition } from 'react'
import {
  CheckCircle2,
  Loader2,
  Pencil,
  Plug,
  Plus,
  Trash2,
  TriangleAlert,
  X,
  XCircle,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { SecretPicker } from '@/features/pick-secret'
import type { ModelSpec } from '@/entities/model'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip, Tooltip } from '@/shared/ui/tooltip'

import { deleteModelAction, saveModelAction, testModelConnectionAction } from '../api/manage-models'

// The newest spec of one model id plus its ownership and version (for the settings card). `spec` may be absent when the detail fetch failed.
// createdBy = whoever registered the FIRST version (absent for seed/_shared) — used to decide whether the delete button shows (registrant-or-admin).
export interface ModelEntry {
  id: string
  owner: string
  versions: string[]
  createdBy?: string
  spec?: ModelSpec
}

// The workspace model management card — registering, editing and reading the supported LLM models as first-class entities rather than as a raw env combination.
// Versions are hidden in the UI (the internal immutable versions remain) — a registration or edit saves only after the connection test passes.
// canDelete = an admin of this workspace (models:delete). currentSubject = the signed-in subject — even a non-admin can delete a model they registered.
export function ModelsManager({
  models,
  secretNames,
  canWrite,
  canDelete,
  currentSubject,
}: {
  models: ModelEntry[]
  secretNames: string[]
  canWrite: boolean
  canDelete: boolean
  currentSubject?: string
}) {
  const t = useTranslations('manageModels')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ModelEntry | null>(null)
  const formOpen = adding || editing !== null

  function closeForm() {
    setAdding(false)
    setEditing(null)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h2 className="text-[15px] font-[560] text-foreground">{t('title')}</h2>
          <InfoTip content={t('help')} />
        </div>
        {canWrite && !formOpen && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="gap-1"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3.5" /> {t('addModel')}
          </Button>
        )}
      </div>

      {canWrite && formOpen && (
        <ModelForm
          mode={editing ? 'edit' : 'add'}
          secretNames={secretNames}
          companionOptions={models.map((m) => m.id).filter((id) => id !== editing?.id)}
          {...(editing ? { initialId: editing.id } : {})}
          {...(editing?.spec ? { initial: editing.spec } : {})}
          onDone={closeForm}
          onCancel={closeForm}
        />
      )}

      {models.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center text-[13px] text-muted-foreground">
          {t('empty')}
          {canWrite && ` ${t('emptyHint')}`}
        </p>
      ) : (
        <SettingsList>
          {models.map((m) => {
            const owned = m.owner !== '_shared'
            return (
              <SettingsRow
                key={m.id}
                label={
                  <span className="flex items-center gap-2">
                    <code className="font-mono text-[13px] text-foreground">{m.id}</code>
                    {!owned && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {t('shared')}
                      </span>
                    )}
                  </span>
                }
                hint={<ModelHint entry={m} secretNames={secretNames} />}
              >
                <span className="flex items-center gap-1">
                  {/* A real connection check — a dummy call, ✓ when it answers and ✗ when it does not (only on a row whose spec is known). */}
                  {m.spec && <RowConnectionCheck id={m.id} spec={m.spec} />}
                  {/* Edit (saved as a new immutable version) — only on a workspace-owned row with write permission and a known spec. */}
                  {owned && canWrite && m.spec && (
                    <button
                      type="button"
                      onClick={() => {
                        setAdding(false)
                        setEditing(m)
                      }}
                      aria-label={t('editModel', { id: m.id })}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  )}
                  {/* Delete shows only for a workspace-owned model (never _shared) and only for an admin or the registrant. The control plane enforces it finally. */}
                  {owned &&
                    (canDelete ||
                      (currentSubject !== undefined && m.createdBy === currentSubject)) && (
                      <DeleteModelControl id={m.id} />
                    )}
                </span>
              </SettingsRow>
            )
          })}
        </SettingsList>
      )}
    </div>
  )
}

// The per-row connection check button — idle (a plug) → in progress (a spinner) → ✓/✗. The result (response or error) goes in the tooltip. Press again to re-check.
function RowConnectionCheck({ id, spec }: { id: string; spec: ModelSpec }) {
  const t = useTranslations('manageModels')
  const [result, setResult] = useState<{ ok: boolean; message?: string }>()
  const [checking, startCheck] = useTransition()

  function run() {
    if (checking) return
    startCheck(async () => {
      const r = await testModelConnectionAction(connectionOf(spec))
      setResult(r.ok ? { ok: true, message: r.text } : { ok: false, message: r.error })
    })
  }

  const icon = checking ? (
    <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
  ) : result?.ok === true ? (
    <CheckCircle2 className="size-3.5 text-emerald-500" />
  ) : result?.ok === false ? (
    <XCircle className="size-3.5 text-destructive" />
  ) : (
    <Plug className="size-3.5 text-faint" />
  )

  const tip =
    result?.ok === true
      ? t('checkOk', { text: result.message ?? '' })
      : result?.ok === false
        ? t('checkFailed', { error: result.message ?? '' })
        : t('checkHint')

  return (
    <Tooltip content={tip}>
      <button
        type="button"
        onClick={run}
        disabled={checking}
        aria-label={t('checkConnection', { id })}
        className="grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-accent disabled:cursor-default"
      >
        {icon}
      </button>
    </Tooltip>
  )
}

// The per-row delete trigger (a bin icon) plus its confirmation dialog. It soft-deletes the whole model (every owned version).
function DeleteModelControl({ id }: { id: string }) {
  const t = useTranslations('manageModels')
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('deleteModel', { id })}
        className="grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </button>
      {open && <DeleteModelDialog id={id} onClose={() => setOpen(false)} />}
    </>
  )
}

// The model delete confirmation dialog — a tombstone (past scorecards keep their reproduction, and later referencing runs fail to resolve). The control plane enforces registrant-or-admin.
function DeleteModelDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations('manageModels')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const titleId = `delete-model-${id}`

  function onConfirm() {
    if (pending) return
    setError(undefined)
    void (async () => {
      setPending(true)
      try {
        const res = await deleteModelAction(id)
        if (!res.ok) {
          setError(res.error ?? t('deleteFailed'))
          return
        }
        toast.success(t('deletedModel', { id }))
        onClose()
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <Dialog open onClose={onClose} className="max-w-md" labelledBy={titleId}>
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/20">
          <TriangleAlert className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-[14px] font-[560] tracking-[-0.01em] text-foreground">
            {t('deleteTitle')}
          </h2>
          <p className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">{id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-3 px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">{t('deleteExplain')}</p>
        <Callout tone="danger" className="py-2">
          {t('deleteWarning')}
        </Callout>
        {error && (
          <Callout tone="danger" className="py-2">
            {error}
          </Callout>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          {t('deleteConfirm')}
        </Button>
      </div>
    </Dialog>
  )
}

// provider · model identifier · baseUrl plus the API key connection state (the linked secret's name / the provider default / an unset warning).
function ModelHint({ entry, secretNames }: { entry: ModelEntry; secretNames: string[] }) {
  const t = useTranslations('manageModels')
  const spec = entry.spec
  if (!spec) return <>{t('detailUnavailable')}</>
  const keyName = spec.apiKeySecret
  const keyMissing = keyName !== undefined && !secretNames.includes(keyName)
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="text-foreground/80">
        {spec.provider} · {spec.model}
      </span>
      {spec.baseUrl && <span className="text-faint">{spec.baseUrl}</span>}
      {keyName ? (
        <span className={keyMissing ? 'text-destructive' : 'text-faint'}>
          {t('keyLinked', { name: keyName })}
          {keyMissing && ` — ${t('keyMissing')}`}
        </span>
      ) : (
        <span className="text-faint">{t('keyDefault')}</span>
      )}
      {/* The companion tier summary — only the configured slots (hide-empty). */}
      {spec.companions &&
        (['small', 'fallback', 'subagent'] as const)
          .filter((slot) => spec.companions?.[slot])
          .map((slot) => (
            <span key={slot} className="text-faint">
              {t(`companionChip.${slot}`, { id: spec.companions?.[slot] ?? '' })}
            </span>
          ))}
    </span>
  )
}

// spec → the connection subset (only the provider, model, baseUrl and apiKeySecret a test or save needs).
function connectionOf(spec: {
  provider: string
  model: string
  baseUrl?: string
  apiKeySecret?: string
}): Record<string, string> {
  return {
    provider: spec.provider,
    model: spec.model,
    ...(spec.baseUrl ? { baseUrl: spec.baseUrl } : {}),
    ...(spec.apiKeySecret ? { apiKeySecret: spec.apiKeySecret } : {}),
  }
}

// The combined register/edit form — provider · id (fixed while editing) · model identifier · baseUrl · apiKeySecret (SecretPicker) · description +
// the companion tiers (small/fallback/subagent — a combo picking another registered model from the same catalog). No version input (assigned internally).
// Save is enabled only AFTER a successful "connection test", and changing a connection field invalidates that test (a companion is not part of the connection, so it does not invalidate).
function ModelForm({
  mode,
  secretNames,
  companionOptions,
  initial,
  initialId,
  onDone,
  onCancel,
}: {
  mode: 'add' | 'edit'
  secretNames: string[]
  companionOptions: string[]
  initial?: ModelSpec
  initialId?: string
  onDone: () => void
  onCancel: () => void
}) {
  const t = useTranslations('manageModels')
  const refresh = useRefresh()
  const editing = mode === 'edit'
  const [provider, setProvider] = useState<string>(initial?.provider ?? 'openai')
  const [id, setId] = useState(initialId ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [apiKeySecret, setApiKeySecret] = useState(initial?.apiKeySecret ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [companionSmall, setCompanionSmall] = useState(initial?.companions?.small ?? '')
  const [companionFallback, setCompanionFallback] = useState(initial?.companions?.fallback ?? '')
  const [companionSubagent, setCompanionSubagent] = useState(initial?.companions?.subagent ?? '')
  const [test, setTest] = useState<{ ok: boolean; text?: string; error?: string }>()
  const [testing, startTest] = useTransition()
  const [saving, startSave] = useTransition()
  const [error, setError] = useState<string>()

  // Changing a field that affects the connection invalidates the previous test result — the connection that gets SAVED must always be the connection that was TESTED.
  function invalidateTest() {
    setTest(undefined)
  }

  const ready = id.trim() !== '' && model.trim() !== ''
  const tested = test?.ok === true

  function connection(): Record<string, string> {
    return {
      provider,
      model: model.trim(),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(apiKeySecret.trim() ? { apiKeySecret: apiKeySecret.trim() } : {}),
    }
  }

  function onTest() {
    if (!ready || testing) return
    setError(undefined)
    startTest(async () => {
      const r = await testModelConnectionAction(connection())
      setTest(r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error })
    })
  }

  // Collect only the selected companions into the spec field — with all three empty the field is not sent at all (no empty object left in the spec).
  function companions(): Record<string, string> | undefined {
    const picked = {
      ...(companionSmall ? { small: companionSmall } : {}),
      ...(companionFallback ? { fallback: companionFallback } : {}),
      ...(companionSubagent ? { subagent: companionSubagent } : {}),
    }
    return Object.keys(picked).length > 0 ? picked : undefined
  }

  function onSave() {
    if (!tested || saving) return
    setError(undefined)
    startSave(async () => {
      const picked = companions()
      const body = {
        ...connection(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(picked ? { companions: picked } : {}),
      }
      const r = await saveModelAction(id.trim(), body)
      if (!r.ok) {
        setError(r.error ?? t('invalid'))
        return
      }
      toast.success(editing ? t('savedEdit', { id: id.trim() }) : t('savedNew', { id: id.trim() }))
      onDone()
      refresh()
    })
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
      <div className="flex items-center gap-1.5">
        <h3 className="text-[13px] font-[560] text-foreground">
          {editing ? t('editTitle', { id: initialId ?? '' }) : t('addModel')}
        </h3>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('formProvider')}>
          <Combobox
            value={provider}
            onChange={(v) => {
              setProvider(v)
              invalidateTest()
            }}
            options={[{ value: 'openai' }, { value: 'anthropic' }]}
            aria-label={t('formProvider')}
          />
        </Field>
        <Field label={t('formId')}>
          <Input
            value={id}
            onChange={(e) => {
              setId(e.target.value)
              invalidateTest()
            }}
            placeholder="gpt-5.4-mini"
            disabled={editing}
          />
        </Field>
        <Field label={t('formModel')} hint={t('formModelHint')}>
          <Input
            value={model}
            onChange={(e) => {
              setModel(e.target.value)
              invalidateTest()
            }}
            placeholder="gpt-5.4-mini"
          />
        </Field>
        <Field label={t('formBaseUrl')} hint={t('formBaseUrlHint')}>
          <Input
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value)
              invalidateTest()
            }}
            placeholder="https://litellm.internal/v1"
          />
        </Field>
        <Field label={t('formApiKey')} hint={t('formApiKeyHint')}>
          <SecretPicker
            value={apiKeySecret}
            onChange={(v) => {
              setApiKeySecret(v)
              invalidateTest()
            }}
            names={secretNames}
            scope="workspace"
            aria-label={t('formApiKey')}
          />
        </Field>
        <Field label={t('formDescription')}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>

      {/* Companion tiers — the registered models that run alongside this one when it drives an agent (the spec beats the deployment env defaults).
          They have nothing to do with the connection, so they do not invalidate the test, and the only candidates are other models registered in this workspace. */}
      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center gap-1.5">
          <h4 className="text-[12.5px] font-[560] text-foreground">{t('companionsTitle')}</h4>
          <InfoTip content={t('companionsHelp')} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t('companionSmall')} hint={t('companionSmallHint')}>
            <CompanionPicker
              value={companionSmall}
              onChange={setCompanionSmall}
              options={companionOptions}
              ariaLabel={t('companionSmall')}
            />
          </Field>
          <Field label={t('companionFallback')} hint={t('companionFallbackHint')}>
            <CompanionPicker
              value={companionFallback}
              onChange={setCompanionFallback}
              options={companionOptions}
              ariaLabel={t('companionFallback')}
            />
          </Field>
          <Field label={t('companionSubagent')} hint={t('companionSubagentHint')}>
            <CompanionPicker
              value={companionSubagent}
              onChange={setCompanionSubagent}
              options={companionOptions}
              ariaLabel={t('companionSubagent')}
            />
          </Field>
        </div>
      </div>

      {/* The connection test result — a response preview on success, the reason on failure. */}
      {test?.ok === true && (
        <Callout tone="info" className="py-2">
          {t('testOk')}
          {test.text ? ` ${test.text}` : ''}
        </Callout>
      )}
      {test?.ok === false && (
        <Callout tone="warning" className="py-2">
          {t('testFailed', { error: test.error ?? '' })}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Save is enabled only after the connection test passes (a disabled button is UX; the control plane enforces it finally). */}
        <Button
          type="button"
          size="sm"
          disabled={!tested || saving}
          onClick={onSave}
          className="gap-1.5"
        >
          {saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="size-3.5" />
          )}
          {saving ? t('saving') : editing ? t('saveEdit') : t('save')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!ready || testing}
          onClick={onTest}
          className="gap-1.5"
        >
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
          {testing ? t('testing') : t('testConnection')}
        </Button>
        {!tested && <span className="text-[11px] text-muted-foreground">{t('testFirst')}</span>}
        <button
          type="button"
          className="ml-auto text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={onCancel}
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  )
}

// The combo for one companion slot — the candidates are the workspace's other registered models plus "none" (an empty value = the slot is unset → falls back to the deployment default).
function CompanionPicker({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
  ariaLabel: string
}) {
  const t = useTranslations('manageModels')
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={[{ value: '', label: t('companionNone') }, ...options.map((id) => ({ value: id }))]}
      aria-label={ariaLabel}
    />
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}
