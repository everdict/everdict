'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import type { BrowserProfile } from '@/entities/browser-profile'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'

import { ProfileLoginWizard } from './profile-login-wizard'

// Saved browser profiles manager (browser-profiles) — personal / self-scoped. Creating a profile is session-first:
// the wizard opens a live browser, the owner logs into the sites the profile should carry (each login surfaces as a
// remembered chip), and finishing captures the cookies. Existing profiles can re-login (re-capture) the same way.
export function BrowserProfilesManager({
  initialProfiles,
  canManageProxies,
}: {
  initialProfiles: BrowserProfile[]
  canManageProxies: boolean
}) {
  const t = useTranslations('browserProfiles')
  const [profiles, setProfiles] = useState<BrowserProfile[]>(initialProfiles)
  // null = closed · {} = create a new profile · { profile } = re-login into an existing one
  const [wizard, setWizard] = useState<{ profile?: BrowserProfile } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onDone = (saved: BrowserProfile) => {
    setProfiles((prev) => [saved, ...prev.filter((p) => p.id !== saved.id)])
    setWizard(null)
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

      {wizard ? (
        <ProfileLoginWizard
          profile={wizard.profile}
          canManageProxies={canManageProxies}
          onDone={onDone}
          onCancel={() => setWizard(null)}
        />
      ) : (
        <div className="flex justify-end">
          <Button onClick={() => setWizard({})}>{t('newProfile')}</Button>
        </div>
      )}

      {profiles.length === 0 ? (
        !wizard && <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {profiles.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              onRename={rename}
              onRemove={remove}
              onRelogin={() => setWizard({ profile: p })}
            />
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
  onRelogin,
}: {
  profile: BrowserProfile
  onRename: (id: string, next: string) => void
  onRemove: (id: string) => void
  onRelogin: () => void
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
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-7 text-[13px]"
              autoFocus
            />
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
              {profile.country && (
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                  {profile.country}
                </span>
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
          <Button size="sm" variant="ghost" onClick={onRelogin}>
            {t('relogin')}
          </Button>
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
