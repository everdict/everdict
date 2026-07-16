'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import type { BrowserProfile } from '@/entities/browser-profile'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'

// Saved browser profiles manager (browser-profiles S2) — personal / self-scoped CRUD. Create a named profile
// (optionally declaring the domains it logs into), rename, or delete. Cookie capture (S3) and eval injection (S5)
// build on it — a profile here is currently a login placeholder.
export function BrowserProfilesManager({ initialProfiles }: { initialProfiles: BrowserProfile[] }) {
  const t = useTranslations('browserProfiles')
  const [profiles, setProfiles] = useState<BrowserProfile[]>(initialProfiles)
  const [name, setName] = useState('')
  const [domains, setDomains] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parseDomains = (raw: string): string[] =>
    raw
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean)

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/browser-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), cookieDomains: parseDomains(domains) }),
      })
      const body = (await res.json()) as BrowserProfile & { error?: string }
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`)
      setProfiles((prev) => [body, ...prev])
      setName('')
      setDomains('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const rename = async (id: string, next: string) => {
    const trimmed = next.trim()
    if (!trimmed) return
    try {
      const res = await fetch(`/api/browser-profiles/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      const body = (await res.json()) as BrowserProfile & { error?: string }
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`)
      setProfiles((prev) => prev.map((p) => (p.id === id ? body : p)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const remove = async (id: string) => {
    setProfiles((prev) => prev.filter((p) => p.id !== id))
    try {
      await fetch(`/api/browser-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch {
      // best-effort — the list re-fetches on reload
    }
  }

  return (
    <div className="space-y-5">
      {error && <Callout tone="danger">{error}</Callout>}

      <form onSubmit={create} className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[12px] text-muted-foreground">{t('nameLabel')}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
        </label>
        <label className="flex flex-[2] flex-col gap-1">
          <span className="text-[12px] text-muted-foreground">{t('domainsLabel')}</span>
          <Input
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder={t('domainsPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? t('creating') : t('create')}
        </Button>
      </form>

      {profiles.length === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {profiles.map((p) => (
            <ProfileRow key={p.id} profile={p} onRename={rename} onRemove={remove} />
          ))}
        </ul>
      )}
    </div>
  )
}

function ProfileRow({
  profile,
  onRename,
  onRemove,
}: {
  profile: BrowserProfile
  onRename: (id: string, next: string) => void
  onRemove: (id: string) => void
}) {
  const t = useTranslations('browserProfiles')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(profile.name)

  return (
    <li className="flex items-center justify-between gap-3 bg-card px-4 py-3">
      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onRename(profile.id, draft)
              setEditing(false)
            }}
            className="flex items-center gap-2"
          >
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 text-[13px]" autoFocus />
            <Button type="submit" size="sm" variant="secondary">
              {t('save')}
            </Button>
          </form>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium">{profile.name}</span>
              {profile.capturedAt ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-success)]/10 px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--color-success)]">
                  {t('loginSaved')}
                </span>
              ) : (
                <span className="shrink-0 text-[10.5px] text-faint">{t('noLogin')}</span>
              )}
            </div>
            <div className="truncate text-[11.5px] text-faint">
              {profile.cookieDomains.length > 0 ? profile.cookieDomains.join(', ') : t('noDomains')}
            </div>
          </>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {t('rename')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onRemove(profile.id)}>
            {t('delete')}
          </Button>
        </div>
      )}
    </li>
  )
}
