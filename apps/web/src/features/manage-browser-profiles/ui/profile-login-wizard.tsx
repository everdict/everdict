'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { BrowserCanvas } from '@/features/interactive-browser'
import { ProxiesManager, type ProxyView } from '@/features/manage-proxies'
import type { BrowserProfile } from '@/entities/browser-profile'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input } from '@/shared/ui/input'

interface RememberedDomain {
  domain: string
  cookieNames: string[]
}

// One login can set a dozen unrelated cookies (analytics, consent, A/B buckets) — the user picks what the
// profile actually keeps. Selection state is a DEselection set so cookies appearing on later polls default to
// selected without wiping earlier choices.
const cookieKey = (domain: string, name: string) => `${domain}|${name}`

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
  const [deselected, setDeselected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'idle' | 'opening' | 'saving'>('idle')
  const [error, setError] = useState<string | null>(null)

  const countries = [...new Set(proxies.map((p) => p.country))].sort()

  const totalCookies = remembered.reduce((sum, d) => sum + d.cookieNames.length, 0)
  const selectedCookies = remembered.flatMap((d) =>
    d.cookieNames
      .filter((name) => !deselected.has(cookieKey(d.domain, name)))
      .map((name) => ({ domain: d.domain, name }))
  )

  const toggleCookie = (domain: string, name: string) =>
    setDeselected((prev) => {
      const next = new Set(prev)
      const key = cookieKey(domain, name)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Domain header toggle — all on ⇒ all off, anything off ⇒ all on.
  const toggleDomain = (d: RememberedDomain) =>
    setDeselected((prev) => {
      const next = new Set(prev)
      const allOn = d.cookieNames.every((name) => !next.has(cookieKey(d.domain, name)))
      for (const name of d.cookieNames) {
        if (allOn) next.add(cookieKey(d.domain, name))
        else next.delete(cookieKey(d.domain, name))
      }
      return next
    })

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
          // Only the cookies the user saw and left selected — a cookie landing between the last poll and the
          // capture is not silently swept in. No cookies observed yet = legacy capture-everything.
          body: JSON.stringify({
            sessionId: session.id,
            ...(totalCookies > 0 ? { cookies: selectedCookies } : {}),
          }),
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
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12.5px] font-medium">{t('rememberedTitle')}</span>
                  {totalCookies > 0 && (
                    <span className="shrink-0 text-[11px] text-faint">
                      {t('selectedCount', { selected: selectedCookies.length, total: totalCookies })}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11.5px] text-faint">{t('rememberedHint')}</p>
              </div>
              {remembered.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">{t('rememberedEmpty')}</p>
              ) : (
                <ul className="max-h-64 space-y-1.5 overflow-y-auto">
                  {remembered.map((d) => {
                    const domainSelected = d.cookieNames.filter(
                      (name) => !deselected.has(cookieKey(d.domain, name))
                    ).length
                    return (
                      <li
                        key={d.domain}
                        className="rounded-md border border-border bg-muted/30 px-2 py-1.5"
                      >
                        <button
                          type="button"
                          onClick={() => toggleDomain(d)}
                          title={t('toggleDomain')}
                          className="flex w-full items-baseline justify-between gap-2 text-left"
                        >
                          <span className="truncate text-[11.5px] font-medium">{d.domain}</span>
                          <span className="shrink-0 font-mono text-[10.5px] text-faint">
                            {domainSelected}/{d.cookieNames.length}
                          </span>
                        </button>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {d.cookieNames.map((name) => {
                            const off = deselected.has(cookieKey(d.domain, name))
                            return (
                              <button
                                key={name}
                                type="button"
                                onClick={() => toggleCookie(d.domain, name)}
                                title={off ? t('cookieExcluded') : t('cookieIncluded')}
                                className={cn(
                                  'max-w-full truncate rounded border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors',
                                  off
                                    ? 'border-border/60 text-faint line-through'
                                    : 'border-primary/40 bg-primary/10'
                                )}
                              >
                                {name}
                              </button>
                            )
                          })}
                        </div>
                      </li>
                    )
                  })}
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
                disabled={
                  busy !== 'idle' ||
                  !name.trim() ||
                  (totalCookies > 0 && selectedCookies.length === 0)
                }
              >
                {busy === 'saving' ? t('savingProfile') : t('saveProfile')}
              </Button>
              {totalCookies > 0 && selectedCookies.length === 0 && (
                <p className="text-[11px] text-muted-foreground">{t('noCookiesSelected')}</p>
              )}
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
