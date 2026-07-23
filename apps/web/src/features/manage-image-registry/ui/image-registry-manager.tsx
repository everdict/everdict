'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'

import { SecretPicker } from '@/features/pick-secret'
import type { ImageRegistryConfig } from '@/entities/image-registry'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { removeImageRegistryAction, upsertImageRegistryAction } from '../api/manage-image-registry'

// Workspace image registries (BYO, multiple) — once an admin registers one it becomes the provenance-classification baseline for harness images,
// and members publish locally built images here via everdict image push (with several, select via --registry <name>).
// pull/push token values are stored only as workspace secret references (names). The two pickers share the list, so
// inline-created ones are merged in via created.
// Rendered inside the Integrations accordion row — the row owns the title/InfoTip, so this renders content only.
export function ImageRegistryManager({
  registries,
  canWrite,
  secretNames,
}: {
  registries: ImageRegistryConfig[]
  canWrite: boolean
  secretNames: string[]
}) {
  const t = useTranslations('manageImageRegistry')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [missingSecrets, setMissingSecrets] = useState<string[]>()
  // Edit target name — a row click prefills the form (save is an upsert keyed by name). undefined = add a new registry.
  const [editing, setEditing] = useState<string>()
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [namespace, setNamespace] = useState('')
  const [username, setUsername] = useState('')
  const [pullName, setPullName] = useState('')
  const [pushName, setPushName] = useState('')
  const [created, setCreated] = useState<string[]>([])
  const names = [...new Set([...secretNames, ...created])]

  function resetForm() {
    setEditing(undefined)
    setName('')
    setHost('')
    setNamespace('')
    setUsername('')
    setPullName('')
    setPushName('')
  }

  function startEdit(r: ImageRegistryConfig) {
    setError(undefined)
    setMissingSecrets(undefined)
    setEditing(r.name)
    setName(r.name)
    setHost(r.host)
    setNamespace(r.namespace ?? '')
    setUsername(r.username ?? '')
    setPullName(r.pullSecretName ?? '')
    setPushName(r.pushSecretName ?? '')
  }

  function onSave() {
    setError(undefined)
    setMissingSecrets(undefined)
    if (!name.trim()) {
      setError(t('validationName'))
      return
    }
    if (!host.trim()) {
      setError(t('validationHost'))
      return
    }
    startTransition(async () => {
      const r = await upsertImageRegistryAction({
        name: name.trim(),
        host: host.trim(),
        ...(namespace.trim() ? { namespace: namespace.trim() } : {}),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(pullName.trim() ? { pullSecretName: pullName.trim() } : {}),
        ...(pushName.trim() ? { pushSecretName: pushName.trim() } : {}),
      })
      if (!r.ok) setError(r.error)
      else {
        setMissingSecrets(r.missingSecrets)
        resetForm()
      }
    })
  }

  function onRemove(target: string) {
    setError(undefined)
    setMissingSecrets(undefined)
    startTransition(async () => {
      const r = await removeImageRegistryAction(target)
      if (!r.ok) setError(r.error)
      else if (editing === target) resetForm()
    })
  }

  return (
    <div className="space-y-3">
      {registries.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('empty')}</p>
      ) : (
        <SettingsList>
          {registries.map((r) => (
            <SettingsRow
              key={r.name}
              label={
                <span className="inline-flex items-center gap-1.5">
                  {r.name}
                  <code className="rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
                    {r.host}
                    {r.namespace ? `/${r.namespace}` : ''}
                  </code>
                </span>
              }
              hint={
                <span className="break-all font-mono text-[11.5px]">
                  {r.imagePrefix}
                  {t('imageRefSuffix')}
                </span>
              }
            >
              {canWrite && (
                <>
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-link hover:text-foreground"
                    disabled={pending}
                    onClick={() => startEdit(r)}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-destructive hover:underline"
                    disabled={pending}
                    onClick={() => onRemove(r.name)}
                  >
                    {t('delete')}
                  </button>
                </>
              )}
            </SettingsRow>
          ))}
        </SettingsList>
      )}

      {registries.length > 0 && (
        <div className="space-y-1 rounded-md border bg-elevated px-3 py-2 text-[12px]">
          <p className="font-[510] text-foreground">{t('pushMethodTitle')}</p>
          <p className="text-muted-foreground">
            {t.rich('pushHint', {
              cmd: (chunks) => <code className="break-all text-foreground">{chunks}</code>,
              flag: (chunks) => <code className="break-all">{chunks}</code>,
            })}
          </p>
        </div>
      )}

      {canWrite && (
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
          <p className="text-[12px] font-[560] text-foreground">
            {editing ? t('editTitle', { name: editing }) : t('addTitle')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="reg-name">{t('nameLabel')}</Label>
              {/* name = upsert key — locked while editing to prevent unintentionally creating a separate registry (rename ≠ upsert). */}
              <Input
                id="reg-name"
                placeholder={t('namePlaceholder')}
                value={name}
                disabled={editing !== undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reg-host">{t('hostLabel')}</Label>
              <Input
                id="reg-host"
                placeholder="ghcr.io · registry.acme.dev:5000"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reg-namespace">{t('namespaceLabel')}</Label>
              <Input
                id="reg-namespace"
                placeholder={t('namespacePlaceholder')}
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reg-username">{t('usernameLabel')}</Label>
              <Input
                id="reg-username"
                placeholder={t('usernamePlaceholder')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            {/* pull/push tokens are workspace secret references, not free text — pick one or create inline. */}
            <div className="space-y-1">
              <Label htmlFor="reg-pull">{t('pullTokenLabel')}</Label>
              <SecretPicker
                id="reg-pull"
                value={pullName}
                onChange={setPullName}
                names={names}
                scope="workspace"
                onCreated={(n) => setCreated((c) => [...c, n])}
                createValuePlaceholder={t('pullTokenPlaceholder')}
                aria-label={t('pullTokenAria')}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reg-push" className="flex items-center gap-1.5">
                {t('pushTokenLabel')}
                <InfoTip
                  content={t.rich('pushTokenTip', {
                    mono: (chunks) => <span className="font-mono">{chunks}</span>,
                  })}
                />
              </Label>
              <SecretPicker
                id="reg-push"
                value={pushName}
                onChange={setPushName}
                names={names}
                scope="workspace"
                onCreated={(n) => setCreated((c) => [...c, n])}
                createValuePlaceholder={t('pushTokenPlaceholder')}
                aria-label={t('pushTokenAria')}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button size="sm" disabled={pending} onClick={onSave}>
              {pending ? t('saving') : editing ? t('update') : t('register')}
            </Button>
            {editing && (
              <button
                type="button"
                className="text-[12px] text-muted-foreground hover:text-foreground"
                disabled={pending}
                onClick={resetForm}
              >
                {t('cancel')}
              </button>
            )}
          </div>
        </div>
      )}

      {missingSecrets && missingSecrets.length > 0 && (
        <Callout tone="warning" className="py-1.5">
          {t('missingSecrets', { names: missingSecrets.join(', ') })}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
