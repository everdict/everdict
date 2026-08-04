'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  Activity,
  Boxes,
  ChevronRight,
  Cpu,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  MessageSquare,
  Package,
  Plus,
  RefreshCw,
  Server,
} from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import type { SecretMeta, SecretScope, SecretUsageMetaRef } from '@/entities/secret'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { FieldError, Input, Label, Textarea } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  deleteSecretAction,
  setOfflineTokenAction,
  setSecretAction,
  type OfflineTokenGrantInput,
} from '../api/manage-secrets'

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
        ? `/${workspace}/harness/${encodeURIComponent(ref.resourceId)}`
        : undefined
    case 'runtime':
      return ref.resourceId
        ? `/${workspace}/runtime/${encodeURIComponent(ref.resourceId)}`
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

// The live reference sites of one secret — collapsed to ONE line by default ("used in N places"), because the point of
// showing references is knowing the secret IS in use, not reading every site; expanding reveals the linked chips.
// Referenced nowhere → an "unused" badge. Computed by the control plane per request, so a removed reference is already gone.
function UsageSites({ refs }: { refs: SecretUsageMetaRef[] }) {
  const t = useTranslations('manageWorkspaceSecrets')
  const { workspace } = useParams<{ workspace: string }>()
  const [open, setOpen] = useState(false)
  if (refs.length === 0)
    return (
      <Badge tone="outline" className="mt-1">
        {t('unused')}
      </Badge>
    )
  return (
    <span className="mt-1 block">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-faint transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {t('usedInCount', { count: refs.length })}
      </button>
      {open && (
        <span className="mt-1 flex flex-wrap items-center gap-1">
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
      )}
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

      <SecretRows
        secrets={secrets}
        canWrite={canWrite}
        scope={scope}
        namePlaceholder={copy.namePlaceholder}
      />

      {!canWrite && <p className="text-[12.5px] text-muted-foreground">{t('adminRequired')}</p>}
    </div>
  )
}

// List (divided card) + top-right "Add secret" → toggled inline form. Linear settings-list style.
function SecretRows({
  secrets,
  canWrite,
  scope,
  namePlaceholder,
}: {
  secrets: SecretRow[]
  canWrite: boolean
  scope: SecretScope
  namePlaceholder: string
}) {
  const t = useTranslations('manageWorkspaceSecrets')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const [adding, setAdding] = useState(false)
  const [addingOffline, setAddingOffline] = useState(false)
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
          {secrets.length > 0 ? t('registeredCount', { count: secrets.length }) : ''}
        </span>
        {canWrite && !adding && !addingOffline && (
          <span className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="gap-1"
              onClick={() => {
                setAddingOffline(true)
                setError(undefined)
              }}
            >
              <RefreshCw className="size-3.5" /> {t('offlineToken.add')}
            </Button>
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
          </span>
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

      {canWrite && addingOffline && (
        <OfflineTokenForm
          scope={scope}
          onDone={() => setAddingOffline(false)}
          onCancel={() => setAddingOffline(false)}
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
              label={
                <span className="flex items-center gap-1.5">
                  <code className="font-mono text-[13px] text-foreground">{s.name}</code>
                  {s.kind === 'offline_token' && (
                    <Badge tone="outline" className="gap-1">
                      <RefreshCw className="size-2.5" />
                      {t('offlineToken.badge')}
                    </Badge>
                  )}
                </span>
              }
              hint={
                <>
                  <span className="block">
                    {t('updatedHint', {
                      date: new Date(s.updatedAt).toLocaleString(locale, { timeZone }),
                    })}
                  </span>
                  {s.kind === 'offline_token' && (
                    <span className="block text-faint">
                      {s.accessTokenExpiresAt
                        ? t('offlineToken.expiresHint', {
                            date: new Date(s.accessTokenExpiresAt).toLocaleString(locale, {
                              timeZone,
                            }),
                          })
                        : t('offlineToken.autoRefreshHint')}
                    </span>
                  )}
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
function AddSecretForm({
  scope,
  namePlaceholder,
  onDone,
  onCancel,
}: {
  scope: SecretScope
  namePlaceholder: string
  onDone: () => void
  onCancel: () => void
}) {
  const t = useTranslations('manageWorkspaceSecrets')
  const [name, setName] = useState('')
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
      <div className="grid gap-3 sm:grid-cols-2">
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
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="secret-value">{t('valueLabel')}</Label>
            <button
              type="button"
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setMultiline((v) => !v)}
            >
              {multiline ? t('singleLine') : t('multiLine')}
            </button>
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

// Register an offline-token secret: a name + the OAuth material (token endpoint, client id, optional client secret,
// the refresh token, optional scope). On save the control plane runs one refresh-token grant to validate it + compute
// the first access-token expiry (a bad grant surfaces as an inline error), and thereafter auto-refreshes on use.
function OfflineTokenForm({
  scope,
  onDone,
  onCancel,
}: {
  scope: SecretScope
  onDone: () => void
  onCancel: () => void
}) {
  const t = useTranslations('manageWorkspaceSecrets')
  const [name, setName] = useState('')
  const [tokenUrl, setTokenUrl] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [oauthScope, setOauthScope] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()
  const nameInvalid = name.length > 0 && !NAME_RE.test(name)
  const incomplete =
    name.length === 0 || tokenUrl.length === 0 || clientId.length === 0 || refreshToken.length === 0

  function onSave() {
    setError(undefined)
    startTransition(async () => {
      const grant: OfflineTokenGrantInput = {
        tokenUrl,
        clientId,
        refreshToken,
        ...(clientSecret ? { clientSecret } : {}),
        ...(oauthScope ? { scope: oauthScope } : {}),
      }
      const r = await setOfflineTokenAction(name, grant, scope)
      if (r.ok) onDone()
      else setError(r.error)
    })
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3.5">
      <p className="text-[12px] text-muted-foreground">{t('offlineToken.formHelp')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="offline-name">{t('nameLabel')}</Label>
          <Input
            id="offline-name"
            value={name}
            placeholder="MY_OFFLINE_TOKEN"
            onChange={(e) => setName(e.target.value.toUpperCase())}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[12px]"
          />
          {nameInvalid && <FieldError message={t('nameInvalid')} />}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="offline-token-url">{t('offlineToken.tokenUrlLabel')}</Label>
          <Input
            id="offline-token-url"
            value={tokenUrl}
            placeholder="https://id.example.com/oauth/token"
            onChange={(e) => setTokenUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="text-[12px]"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="offline-client-id">{t('offlineToken.clientIdLabel')}</Label>
          <Input
            id="offline-client-id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[12px]"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="offline-client-secret">{t('offlineToken.clientSecretLabel')}</Label>
          <Input
            id="offline-client-secret"
            type="password"
            value={clientSecret}
            placeholder={t('offlineToken.optional')}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="text-[12px]"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="offline-refresh-token">{t('offlineToken.refreshTokenLabel')}</Label>
          <div className="relative">
            <Input
              id="offline-refresh-token"
              type={show ? 'text' : 'password'}
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="pr-8 font-mono text-[12px]"
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
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="offline-scope">{t('offlineToken.scopeLabel')}</Label>
          <Input
            id="offline-scope"
            value={oauthScope}
            placeholder={t('offlineToken.optional')}
            onChange={(e) => setOauthScope(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="text-[12px]"
          />
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
          disabled={pending || incomplete || nameInvalid}
          onClick={onSave}
        >
          <RefreshCw className="size-3.5" />{' '}
          {pending ? t('offlineToken.registering') : t('register')}
        </Button>
        <button
          type="button"
          className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={onCancel}
        >
          {t('cancel')}
        </button>
        <span className="text-[11px] text-faint">{t('offlineToken.saveNote')}</span>
      </div>
    </div>
  )
}
