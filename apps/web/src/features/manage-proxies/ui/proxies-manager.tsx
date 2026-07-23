'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { z } from 'zod'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'

// Redacted proxy view the control plane returns (the auth secret is a name-ref, its value never crosses the wire).
export const proxyViewSchema = z.object({
  name: z.string(),
  country: z.string(),
  url: z.string(),
  authSecretName: z.string().optional(),
})
export const proxyListResponseSchema = z.object({ proxies: z.array(proxyViewSchema) })
export type ProxyView = z.infer<typeof proxyViewSchema>

// Workspace BYO egress proxy manager (browser-profiles S4) — admin registers per-country proxies used by the
// interactive login browser (and eval browsers, S5). The auth secret is a SecretStore name-ref (value never shown).
// Reads are a workspace read (any member picks a geo); writes are admin — `canManage` hides the add form + delete
// (read-only list) for non-admins. Used both standalone (Settings › Browser › Proxies) and embedded in the
// profile-creation wizard's geo step, where onChange refreshes the host's country picker live.
export function ProxiesManager({
  initialProxies,
  onChange,
  canManage = true,
}: {
  initialProxies: ProxyView[]
  onChange?: (proxies: ProxyView[]) => void
  canManage?: boolean
}) {
  const t = useTranslations('proxies')
  const [proxies, setProxies] = useState<ProxyView[]>(initialProxies)
  const [form, setForm] = useState({ name: '', country: '', url: '', authSecretName: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Notify the host (the wizard's geo picker) so an add/remove is reflected in its country options immediately.
  useEffect(() => {
    onChange?.(proxies)
  }, [proxies, onChange])

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.country.trim() || !form.url.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/workspace/proxies', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          country: form.country.trim(),
          url: form.url.trim(),
          ...(form.authSecretName.trim() ? { authSecretName: form.authSecretName.trim() } : {}),
        }),
      })
      const body = (await res.json()) as {
        config?: ProxyView
        error?: string
        missingSecrets?: string[]
      }
      if (!res.ok || body.error || !body.config) throw new Error(body.error ?? `HTTP ${res.status}`)
      const config = body.config
      setProxies((prev) => [...prev.filter((p) => p.name !== config.name), config])
      setForm({ name: '', country: '', url: '', authSecretName: '' })
      if (body.missingSecrets?.length)
        setError(t('missingSecret', { name: body.missingSecrets.join(', ') }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string) => {
    setProxies((prev) => prev.filter((p) => p.name !== name))
    try {
      await fetch(`/api/workspace/proxies/${encodeURIComponent(name)}`, { method: 'DELETE' })
    } catch {
      // best-effort
    }
  }

  return (
    <div className="space-y-5">
      {error && <Callout tone="warning">{error}</Callout>}

      {canManage ? (
        <form
          onSubmit={save}
          className="grid grid-cols-1 gap-2 rounded-xl border border-border bg-card p-4 sm:grid-cols-4"
        >
          <Input value={form.name} onChange={set('name')} placeholder={t('namePlaceholder')} />
          <Input
            value={form.country}
            onChange={set('country')}
            placeholder={t('countryPlaceholder')}
          />
          <Input
            value={form.url}
            onChange={set('url')}
            placeholder={t('urlPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
          <Input
            value={form.authSecretName}
            onChange={set('authSecretName')}
            placeholder={t('secretPlaceholder')}
          />
          <div className="sm:col-span-4">
            <Button
              type="submit"
              disabled={busy || !form.name.trim() || !form.country.trim() || !form.url.trim()}
            >
              {busy ? t('saving') : t('add')}
            </Button>
          </div>
        </form>
      ) : (
        <Callout tone="muted">{t('readonly')}</Callout>
      )}

      {proxies.length === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {proxies.map((p) => (
            <li key={p.name} className="flex items-center justify-between gap-3 bg-card px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  <span className="truncate">{p.name}</span>
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                    {p.country}
                  </span>
                </div>
                <div className="truncate text-[11.5px] text-faint">
                  {p.url}
                  {p.authSecretName
                    ? ` · ${t('authRef', { name: p.authSecretName })}`
                    : ` · ${t('open')}`}
                </div>
              </div>
              {canManage && (
                <Button size="sm" variant="ghost" onClick={() => remove(p.name)}>
                  {t('delete')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
