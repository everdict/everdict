'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { BrowserCanvas } from '@/features/interactive-browser'
import { ProxiesManager, type ProxyView } from '@/features/manage-proxies'
import type { BrowserProfile } from '@/entities/browser-profile'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input } from '@/shared/ui/input'

interface RememberedDomain {
  domain: string
  cookieNames: string[]
}

// Session-first browser-profile creation (browser-profiles): making a profile IS a login session. A live browser
// opens (optionally through a per-country egress proxy), the owner logs into every site the profile should carry,
// each login surfaces live as a "remembered" chip (per-domain cookie names — never values), and finishing captures
// the session's cookies into the profile. Nothing persists on cancel. profile set = re-login into an existing one.
export function ProfileLoginWizard({
  profile,
  canManageProxies,
  onDone,
  onCancel,
}: {
  profile?: BrowserProfile // absent = create a new profile; present = re-capture its login
  canManageProxies: boolean // settings:write — shows the inline egress-proxy manager
  onDone: (profile: BrowserProfile) => void
  onCancel: () => void
}) {
  const t = useTranslations('browserProfiles')
  const [name, setName] = useState(profile?.name ?? '')
  const [country, setCountry] = useState(profile?.country ?? '')
  const [proxies, setProxies] = useState<ProxyView[]>([])
  const [showProxies, setShowProxies] = useState(false)
  const [session, setSession] = useState<{ id: string } | null>(null)
  const [remembered, setRemembered] = useState<RememberedDomain[]>([])
  const [busy, setBusy] = useState<'idle' | 'opening' | 'saving'>('idle')
  const [error, setError] = useState<string | null>(null)

  const countries = [...new Set(proxies.map((p) => p.country))].sort()

  // The workspace's egress proxies (browser-profiles S4) — the geo the login session runs through.
  useEffect(() => {
    let stopped = false
    ;(async () => {
      try {
        const res = await fetch('/api/workspace/proxies')
        if (!res.ok) return
        const body = (await res.json()) as { proxies?: ProxyView[] }
        if (!stopped && body.proxies) setProxies(body.proxies)
      } catch {
        // no proxies configured — the geo picker stays hidden
      }
    })()
    return () => {
      stopped = true
    }
  }, [])

  // Poll the live "what a capture would remember" summary while the session is open — each login the user
  // performs in the canvas surfaces as a chip. Names only; cookie values never reach the client.
  const polling = useRef(false)
  useEffect(() => {
    if (!session) return
    let stopped = false
    const tick = async () => {
      if (polling.current) return
      polling.current = true
      try {
        const res = await fetch(
          `/api/browser-sessions/${encodeURIComponent(session.id)}/state-preview`
        )
        if (!res.ok) return
        const body = (await res.json()) as { domains?: RememberedDomain[] }
        if (!stopped && body.domains) setRemembered(body.domains)
      } catch {
        // transient — the next tick retries
      } finally {
        polling.current = false
      }
    }
    void tick()
    const timer = setInterval(tick, 4000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [session])

  const openBrowser = async () => {
    setBusy('opening')
    setError(null)
    try {
      const res = await fetch('/api/browser-sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(country ? { country } : {}),
      })
      const body = (await res.json()) as { id: string; error?: string }
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`)
      setSession({ id: body.id })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('idle')
    }
  }

  const closeSession = async (id: string) => {
    try {
      await fetch(`/api/browser-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch {
      // best-effort — the backend also tears the browser down on TTL
    }
  }

  const saveAndFinish = async () => {
    if (!session || !name.trim()) return
    setBusy('saving')
    setError(null)
    try {
      let profileId = profile?.id
      if (!profileId) {
        const created = await fetch('/api/browser-profiles', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), ...(country ? { country } : {}) }),
        })
        const body = (await created.json()) as { id: string; error?: string }
        if (!created.ok || body.error) throw new Error(body.error ?? `HTTP ${created.status}`)
        profileId = body.id
      }
      const captured = await fetch(
        `/api/browser-profiles/${encodeURIComponent(profileId)}/capture`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: session.id }),
        }
      )
      const body = (await captured.json()) as BrowserProfile & { error?: string }
      if (!captured.ok || body.error) throw new Error(body.error ?? `HTTP ${captured.status}`)
      await closeSession(session.id)
      onDone(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy('idle')
    }
  }

  const cancel = async () => {
    if (session) await closeSession(session.id)
    onCancel()
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div>
        <h3 className="text-[13.5px] font-medium">
          {profile ? t('wizardReloginTitle', { name: profile.name }) : t('wizardCreateTitle')}
        </h3>
        <p className="mt-1 text-[12px] text-muted-foreground">{t('wizardIntro')}</p>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      {!session ? (
        <div className="space-y-3">
          {!profile && (
            <label className="flex max-w-sm flex-col gap-1">
              <span className="text-[12px] text-muted-foreground">{t('nameLabel')}</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
              />
            </label>
          )}
          {(countries.length > 0 || canManageProxies) && (
            <div className="space-y-2">
              <label className="flex max-w-sm flex-col gap-1">
                <span className="text-[12px] text-muted-foreground">{t('geoLabel')}</span>
                <div className="flex items-center gap-2">
                  <select
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    className="h-8 rounded-md border border-border bg-background px-2 text-[12px]"
                  >
                    <option value="">{t('geoDirect')}</option>
                    {countries.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {canManageProxies && (
                    <Button size="sm" variant="ghost" onClick={() => setShowProxies((v) => !v)}>
                      {t('manageProxies')}
                    </Button>
                  )}
                </div>
              </label>
              {showProxies && canManageProxies && (
                <div className="rounded-lg border border-border p-3">
                  <ProxiesManager initialProxies={proxies} onChange={setProxies} />
                </div>
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button onClick={openBrowser} disabled={busy !== 'idle' || (!profile && !name.trim())}>
              {busy === 'opening' ? t('opening') : t('openBrowser')}
            </Button>
            <Button variant="ghost" onClick={cancel}>
              {t('cancelSession')}
            </Button>
          </div>
        </div>
      ) : (
        // Live step — the canvas is the protagonist (left, full width); the capture state + finish actions live in a
        // sticky right rail so "what will be saved" and the save button stay visible without scrolling past the screen.
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
          <BrowserCanvas sessionId={session.id} />

          <aside className="space-y-3 xl:sticky xl:top-4 xl:self-start">
            <div className="space-y-2 rounded-lg border border-border bg-card/60 p-3">
              <div>
                <span className="text-[12.5px] font-medium">{t('rememberedTitle')}</span>
                <p className="mt-0.5 text-[11.5px] text-faint">{t('rememberedHint')}</p>
              </div>
              {remembered.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">{t('rememberedEmpty')}</p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto">
                  {remembered.map((d) => (
                    <li
                      key={d.domain}
                      title={d.cookieNames.join(', ')}
                      className="flex items-baseline justify-between gap-2 rounded-md border border-border bg-muted/30 px-2 py-1 text-[11.5px]"
                    >
                      <span className="truncate font-medium">{d.domain}</span>
                      <span className="shrink-0 text-faint">
                        {t('cookieCount', { count: d.cookieNames.length })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-2.5 rounded-lg border border-border bg-card/60 p-3">
              {!profile && (
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-muted-foreground">{t('nameLabel')}</span>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('namePlaceholder')}
                  />
                </label>
              )}
              <Button
                className="w-full"
                onClick={saveAndFinish}
                disabled={busy !== 'idle' || !name.trim()}
              >
                {busy === 'saving' ? t('savingProfile') : t('saveProfile')}
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                onClick={cancel}
                disabled={busy === 'saving'}
              >
                {t('cancelSession')}
              </Button>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
