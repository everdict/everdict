'use client'

import { useState } from 'react'
import { Pencil, RotateCw, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { BrowserProfile } from '@/entities/browser-profile'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
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
  // A profile pending delete confirmation (captured logins are destroyed with it — never a one-click delete).
  const [confirming, setConfirming] = useState<BrowserProfile | null>(null)
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
              onRemove={() => setConfirming(p)}
              onRelogin={() => setWizard({ profile: p })}
            />
          ))}
        </ul>
      )}

      <Dialog open={confirming !== null} onClose={() => setConfirming(null)} className="max-w-sm">
        {confirming && (
          <div className="space-y-3 p-4">
            <h3 className="text-[13.5px] font-medium">{t('deleteConfirmTitle')}</h3>
            <p className="text-[12.5px] text-muted-foreground">
              {t('deleteConfirmBody', { name: confirming.name })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  remove(confirming.id)
                  setConfirming(null)
                }}
              >
                {t('delete')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
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
  onRemove: () => void
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
        <div className="flex shrink-0 items-center gap-0.5">
          {/* Re-login is the row's primary action — it keeps its label; housekeeping shrinks to icons. */}
          <Button size="sm" variant="ghost" onClick={onRelogin} className="gap-1.5">
            <RotateCw className="size-3.5" />
            {t('relogin')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing(true)}
            aria-label={t('rename')}
            title={t('rename')}
            className="size-7 p-0"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRemove}
            aria-label={t('delete')}
            title={t('delete')}
            className="size-7 p-0 text-muted-foreground hover:text-[var(--color-danger)]"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      )}
    </li>
  )
}
