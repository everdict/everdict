'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  Activity,
  Boxes,
  Cpu,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  MessageSquare,
  Package,
  Plus,
  Server,
} from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import {
  PROVIDER_TOKENS,
  providerTokenNames,
  type ProviderTokenDef,
  type SecretMeta,
  type SecretScope,
  type SecretUsageMetaRef,
} from '@/entities/secret'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { FieldError, Input, Label, Textarea } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { deleteSecretAction, setSecretAction } from '../api/manage-secrets'

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

// A secret row optionally carries its live reference sites (workspace variant only; personal secrets pass none).
type SecretRow = SecretMeta & { refs?: SecretUsageMetaRef[] }

// Per-kind icon + the workspace-relative deep-link target for a usage site (proxy has no dedicated page → no link).
const USAGE_KIND_ICON = {
  harness: Boxes,
  runtime: Server,
  model: Cpu,
  mattermost: MessageSquare,
  imageRegistry: Package,
  traceSource: Activity,
  proxy: Globe,
} as const

function usageHref(ref: SecretUsageMetaRef, workspace: string): string | undefined {
  switch (ref.kind) {
    case 'harness':
      return ref.resourceId
        ? `/${workspace}/harnesses/${encodeURIComponent(ref.resourceId)}`
        : undefined
    case 'runtime':
      return ref.resourceId
        ? `/${workspace}/runtimes/${encodeURIComponent(ref.resourceId)}`
        : undefined
    case 'model':
      return `/${workspace}/settings/models`
    case 'mattermost':
    case 'imageRegistry':
    case 'traceSource':
      return `/${workspace}/settings/integrations`
    default:
      return undefined
  }
}

// The live reference sites of one secret — chips (linked where the resource has a page), or an "unused" badge when
// the secret is referenced nowhere. Computed by the control plane per request, so a removed reference is already gone.
function UsageSites({ refs }: { refs: SecretUsageMetaRef[] }) {
  const t = useTranslations('manageWorkspaceSecrets')
  const { workspace } = useParams<{ workspace: string }>()
  if (refs.length === 0)
    return (
      <Badge tone="outline" className="mt-1">
        {t('unused')}
      </Badge>
    )
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1">
      <span className="text-[11px] text-faint">{t('usedBy')}</span>
      {refs.map((ref) => {
        const Icon = USAGE_KIND_ICON[ref.kind]
        const href = usageHref(ref, workspace)
        const key = `${ref.kind}:${ref.resourceId ?? ref.label}:${ref.field}:${ref.detail ?? ''}`
        const chip =
          'inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px]'
        const body = (
          <>
            <Icon className="size-3 shrink-0 text-muted-foreground/70" />
            <span className="font-mono text-foreground/80">{ref.label}</span>
            <span className="text-faint">
              {t(`usageField.${ref.field}`)}
              {ref.detail ? ` ${ref.detail}` : ''}
            </span>
          </>
        )
        return href ? (
          <Link
            key={key}
            href={href}
            title={t(`usageKind.${ref.kind}`)}
            className={cn(chip, 'transition-colors hover:border-primary/40 hover:bg-muted')}
          >
            {body}
          </Link>
        ) : (
          <span key={key} title={t(`usageKind.${ref.kind}`)} className={chip}>
            {body}
          </span>
        )
      })}
    </span>
  )
}

// workspace = workspace (shared) secrets — the store is a single flat namespace with no categories, so the UI is one list too
// (splitting model keys vs cluster credentials would double-expose the same secret on both sides). personal = my personal secrets (account screen, self-managed).
// namePlaceholder is a reserved-name example (not for translation) — the rest of the copy comes from next-intl messages.
const COPY = {
  workspace: { namePlaceholder: 'OPENAI_API_KEY' },
  personal: { namePlaceholder: 'MY_OPENAI_API_KEY' },
} as const

export function SecretsManager({
  variant,
  secrets,
  canWrite,
}: {
  variant: 'workspace' | 'personal'
  secrets: SecretRow[]
  canWrite: boolean
}) {
  const t = useTranslations('manageWorkspaceSecrets')
  const copy = COPY[variant]
  // personal = personal (user) scope (self-managed), workspace = shared (admin).
  const scope: SecretScope = variant === 'personal' ? 'user' : 'workspace'
  // Provider tokens (reserved names, consumed by the platform) — curate only the ones consumed in this scope.
  const providers = PROVIDER_TOKENS.filter((pt) => pt.scopes.includes(scope))
  // Exclude provider tokens from the raw list (avoid double exposure — the curated section above is their place).
  const rawSecrets = secrets.filter((s) => !(providerTokenNames.has(s.name) && s.scope === scope))

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
            {t(`${variant}.title`)}
            <InfoTip
              content={
                <>
                  {t(`${variant}.help`)}
                  <br />
                  {t('encryptedNote')}
                </>
              }
            />
          </h3>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {t(`${variant}.desc`)}
          </p>
        </div>
      </div>

      {providers.length > 0 && (
        <ProviderTokenRows
          providers={providers}
          secrets={secrets}
          scope={scope}
          canWrite={canWrite}
        />
      )}

      <SecretRows
        secrets={rawSecrets}
        canWrite={canWrite}
        scope={scope}
        namePlaceholder={copy.namePlaceholder}
        {...(providers.length > 0 ? { sectionLabel: t('customSecretsLabel') } : {})}
      />

      {!canWrite && <p className="text-[12.5px] text-muted-foreground">{t('adminRequired')}</p>}
    </div>
  )
}

// Provider tokens — a curated list with predefined reserved names. Users register by "which service token it is" without knowing the name.
function ProviderTokenRows({
  providers,
  secrets,
  scope,
  canWrite,
}: {
  providers: ProviderTokenDef[]
  secrets: SecretMeta[]
  scope: SecretScope
  canWrite: boolean
}) {
  const t = useTranslations('manageWorkspaceSecrets')
  const locale = useLocale()
  const [editing, setEditing] = useState<string>() // name of the token whose register/replace form is open
  const [confirmName, setConfirmName] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onDelete(target: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await deleteSecretAction(target, scope)
      setConfirmName(undefined)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <div className="space-y-2.5">
      <span className="text-[11px] font-[510] uppercase tracking-wide text-faint">
        {t('providerTokensLabel')}
      </span>
      <SettingsList>
        {providers.map((pt) => {
          const registered = secrets.find((s) => s.name === pt.name && s.scope === scope)
          return (
            <SettingsRow
              key={pt.name}
              label={
                <span className="flex items-center gap-1.5">
                  <span className="text-[13px] font-[560] text-foreground">
                    {t(`providerTokens.${pt.name}.provider`)}
                  </span>
                  <InfoTip
                    content={
                      <>
                        {t(`providerTokens.${pt.name}.help`)}
                        <br />
                        {t.rich('savedAsName', {
                          name: pt.name,
                          code: (chunks) => <code className="font-mono">{chunks}</code>,
                        })}
                      </>
                    }
                  />
                </span>
              }
              hint={
                registered
                  ? t('registeredHint', {
                      usedFor: t(`providerTokens.${pt.name}.usedFor`),
                      date: new Date(registered.updatedAt).toLocaleDateString(locale),
                    })
                  : t(`providerTokens.${pt.name}.usedFor`)
              }
            >
              {canWrite && (
                <span className="flex items-center gap-2.5">
                  {registered ? (
                    confirmName === pt.name ? (
                      <>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={pending}
                          onClick={() => onDelete(pt.name)}
                        >
                          {t('deleteConfirm')}
                        </Button>
                        <button
                          type="button"
                          className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => setConfirmName(undefined)}
                        >
                          {t('cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => setEditing(editing === pt.name ? undefined : pt.name)}
                        >
                          {t('replace')}
                        </button>
                        <button
                          type="button"
                          className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-destructive"
                          onClick={() => setConfirmName(pt.name)}
                        >
                          {t('delete')}
                        </button>
                      </>
                    )
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setEditing(editing === pt.name ? undefined : pt.name)}
                    >
                      {t('register')}
                    </Button>
                  )}
                  <a
                    href={pt.helpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                  >
                    {t('issue')}
                  </a>
                </span>
              )}
            </SettingsRow>
          )
        })}
      </SettingsList>
      {editing && (
        <AddSecretForm
          scope={scope}
          namePlaceholder=""
          fixedName={editing}
          onDone={() => setEditing(undefined)}
          onCancel={() => setEditing(undefined)}
        />
      )}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}

// List (divided card) + top-right "Add secret" → toggled inline form. Linear settings-list style.
function SecretRows({
  secrets,
  canWrite,
  scope,
  namePlaceholder,
  sectionLabel,
}: {
  secrets: SecretRow[]
  canWrite: boolean
  scope: SecretScope
  namePlaceholder: string
  sectionLabel?: string // distinguishing label when shown alongside the provider tokens section
}) {
  const t = useTranslations('manageWorkspaceSecrets')
  const locale = useLocale()
  const [adding, setAdding] = useState(false)
  const [confirmName, setConfirmName] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onDelete(target: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await deleteSecretAction(target, scope)
      setConfirmName(undefined)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-[510] text-faint">
          {sectionLabel ? (
            <span className="text-[11px] uppercase tracking-wide">{sectionLabel}</span>
          ) : secrets.length > 0 ? (
            t('registeredCount', { count: secrets.length })
          ) : (
            ''
          )}
        </span>
        {canWrite && !adding && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="gap-1"
            onClick={() => {
              setAdding(true)
              setError(undefined)
            }}
          >
            <Plus className="size-3.5" /> {t('addSecret')}
          </Button>
        )}
      </div>

      {canWrite && adding && (
        <AddSecretForm
          scope={scope}
          namePlaceholder={namePlaceholder}
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      )}

      {secrets.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center text-[13px] text-muted-foreground">
          {t('emptyTitle')}
          {canWrite && t('emptyHint')}
        </p>
      ) : (
        <SettingsList>
          {secrets.map((s) => (
            <SettingsRow
              key={s.name}
              label={<code className="font-mono text-[13px] text-foreground">{s.name}</code>}
              hint={
                <>
                  <span className="block">
                    {t('updatedHint', { date: new Date(s.updatedAt).toLocaleString(locale) })}
                  </span>
                  {s.refs !== undefined && <UsageSites refs={s.refs} />}
                </>
              }
            >
              {canWrite &&
                (confirmName === s.name ? (
                  <span className="flex items-center gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => onDelete(s.name)}
                    >
                      {t('deleteConfirm')}
                    </Button>
                    <button
                      type="button"
                      className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => setConfirmName(undefined)}
                    >
                      {t('cancel')}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-destructive"
                    onClick={() => setConfirmName(s.name)}
                  >
                    {t('delete')}
                  </button>
                ))}
            </SettingsRow>
          ))}
        </SettingsList>
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}

// Toggled inline add form — name + value (single-line ↔ multi-line toggle; single-line has a show toggle) + save/cancel. Compact inside the card.
// fixedName = provider token (reserved name): hide the name input and take only the value (single-line).
function AddSecretForm({
  scope,
  namePlaceholder,
  fixedName,
  onDone,
  onCancel,
}: {
  scope: SecretScope
  namePlaceholder: string
  fixedName?: string
  onDone: () => void
  onCancel: () => void
}) {
  const t = useTranslations('manageWorkspaceSecrets')
  const [name, setName] = useState(fixedName ?? '')
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [multiline, setMultiline] = useState(false) // toggle for multi-line value input like a kubeconfig
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()
  const nameInvalid = name.length > 0 && !NAME_RE.test(name)

  function onSave() {
    setError(undefined)
    startTransition(async () => {
      const r = await setSecretAction(name, value, scope)
      if (r.ok) onDone()
      else setError(r.error)
    })
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3.5">
      <div className={fixedName ? 'grid gap-3' : 'grid gap-3 sm:grid-cols-2'}>
        {!fixedName && (
          <div className="space-y-1.5">
            <Label htmlFor="secret-name">{t('nameLabel')}</Label>
            <Input
              id="secret-name"
              value={name}
              placeholder={namePlaceholder}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-[12px]"
            />
            {nameInvalid && <FieldError message={t('nameInvalid')} />}
          </div>
        )}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="secret-value">{t('valueLabel')}</Label>
            {!fixedName && (
              <button
                type="button"
                className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setMultiline((v) => !v)}
              >
                {multiline ? t('singleLine') : t('multiLine')}
              </button>
            )}
          </div>
          {multiline ? (
            <Textarea
              id="secret-value"
              value={value}
              placeholder={t('multilinePlaceholder')}
              onChange={(e) => setValue(e.target.value)}
              rows={4}
              spellCheck={false}
              className="text-[12px]"
            />
          ) : (
            <div className="relative">
              <Input
                id="secret-value"
                type={show ? 'text' : 'password'}
                value={value}
                placeholder={t('valuePlaceholder')}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="pr-8 text-[12px]"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? t('hideValue') : t('showValue')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
          )}
        </div>
      </div>
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="gap-1"
          disabled={pending || name.length === 0 || value.length === 0 || nameInvalid}
          onClick={onSave}
        >
          <KeyRound className="size-3.5" /> {pending ? t('saving') : t('save')}
        </Button>
        <button
          type="button"
          className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={onCancel}
        >
          {t('cancel')}
        </button>
        <span className="text-[11px] text-faint">{t('saveNote')}</span>
      </div>
    </div>
  )
}
