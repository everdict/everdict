'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input } from '@/shared/ui/input'

import { BrowserCanvas } from './browser-canvas'

interface SessionView {
  id: string
  status: string
}

// Interactive browser session panel (browser-profiles S1) — starts a dedicated browser and hands it to the canvas
// so the owner drives it live (navigate, click, type, log in). Personal / self-scoped; one active session at a time.
export function InteractiveBrowserPanel({ initialSession }: { initialSession: SessionView | null }) {
  const t = useTranslations('interactiveBrowser')
  const [session, setSession] = useState<SessionView | null>(initialSession)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/browser-sessions', { method: 'POST' })
      const body = (await res.json()) as SessionView & { error?: string }
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`)
      setSession({ id: body.id, status: body.status })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const close = async () => {
    if (!session) return
    setBusy(true)
    try {
      await fetch(`/api/browser-sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' })
    } catch {
      // best-effort — the backend also tears the browser down on TTL
    } finally {
      setSession(null)
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && <Callout tone="danger">{error}</Callout>}

      {session ? (
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[12px] text-muted-foreground">{session.id}</span>
            <Button size="sm" variant="secondary" onClick={close} disabled={busy}>
              {t('close')}
            </Button>
          </div>
          <BrowserCanvas sessionId={session.id} />
          <SaveLogin sessionId={session.id} />
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-6">
          <p className="text-[13px] text-muted-foreground">{t('startHint')}</p>
          <Button onClick={start} disabled={busy}>
            {busy ? t('starting') : t('start')}
          </Button>
        </div>
      )}
    </div>
  )
}

// Save the current session's login (cookies) as a reusable browser profile (browser-profiles S3): create a profile,
// then capture the session's cookies into it. Log into a site in the canvas above first.
function SaveLogin({ sessionId }: { sessionId: string }) {
  const t = useTranslations('interactiveBrowser')
  const [name, setName] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setState('saving')
    setError(null)
    try {
      const created = await fetch('/api/browser-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      const profile = (await created.json()) as { id: string; error?: string }
      if (!created.ok || profile.error) throw new Error(profile.error ?? `HTTP ${created.status}`)
      const captured = await fetch(`/api/browser-profiles/${encodeURIComponent(profile.id)}/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const body = (await captured.json()) as { error?: string }
      if (!captured.ok || body.error) throw new Error(body.error ?? `HTTP ${captured.status}`)
      setState('saved')
      setName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setState('idle')
    }
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-[11.5px] text-faint">{t('saveLoginHint')}</p>
      {error && <Callout tone="danger">{error}</Callout>}
      {state === 'saved' ? (
        <p className="text-[12px] text-[var(--color-success)]">{t('saveLoginDone')}</p>
      ) : (
        <form onSubmit={save} className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('saveLoginPlaceholder')}
            className="text-[12px]"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={state === 'saving' || !name.trim()}>
            {state === 'saving' ? t('saveLoginSaving') : t('saveLogin')}
          </Button>
        </form>
      )}
    </div>
  )
}
