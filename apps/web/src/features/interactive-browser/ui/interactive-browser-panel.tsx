'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

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
