'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { useRunLiveStream } from '@/entities/run'
import { BrowserCanvas } from '@/features/interactive-browser'
import { Button } from '@/shared/ui/button'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded'])

// The live screen — it polls a running case's current frame every 2s and shows it as an <img>. Frames come from three sources: os-use scrot ·
// a browser topology's CDP capture · a self-hosted runner pushing its own container's screen (browser-use's Chromium, etc.).
// Nothing is rendered until a frame exists (a run with no live screen is invisible), and polling is not abandoned over a slow first frame.
// Once the run reaches a terminal state, polling stops and the last frame is left standing.
export function LiveScreen({ runId, initialStatus }: { runId: string; initialStatus?: string }) {
  const t = useTranslations('liveScreen')
  const [src, setSrc] = useState('')
  const [supported, setSupported] = useState(false)
  const [driving, setDriving] = useState(false)
  // With the multiplexed stream (④) attached, frames come from THERE — this widget's 2s poll lives on only as the fallback.
  const stream = useRunLiveStream()
  const streamed = stream?.connected ? stream.screenDataUrl : undefined

  useEffect(() => {
    if (initialStatus && TERMINAL.has(initialStatus)) return
    if (stream?.connected) return // polling rests while the stream pushes frames
    if (driving) return // while driving, the screencast replaces the view — polling on top would scrape the same browser twice
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/screen`)
        if (res.ok) {
          const body = (await res.json()) as {
            status?: string
            supported: boolean
            found: boolean
            dataUrl: string
          }
          if (stopped) return
          setSupported(body.supported)
          setSrc(body.found ? body.dataUrl : '')
          if (body.status && TERMINAL.has(body.status)) return // run ended — stop polling, keep the last frame
        }
      } catch {
        // transient — keep polling
      }
      if (!stopped) timer = setTimeout(tick, 2000)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [runId, initialStatus, driving, stream?.connected])

  // A stream frame is the newest when there is one — a polled frame is the fallback. A run with no live screen hides entirely.
  const effSrc = streamed ?? src
  if (!supported && !effSrc) return null

  // Drive mode — from watching to DOING. It is the channel by which a person takes over when a case is blocked by a login wall or a captcha,
  // so the moment it attaches the polled image is replaced by the real browser (screencast plus input).
  if (driving) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] text-faint">{t('driving')}</span>
          <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setDriving(false)}>
            {t('stopDriving')}
          </Button>
        </div>
        <BrowserCanvas sessionId={runId} ticketPath={`/api/runs/${encodeURIComponent(runId)}/screen-ticket`} />
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] text-faint">{t('label')}</span>
        {effSrc && (
          <Button type="button" size="sm" variant="secondary" className="ml-auto" onClick={() => setDriving(true)}>
            {t('takeOver')}
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-black">
        {effSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={effSrc} alt={t('label')} className="max-h-[28rem] w-full object-contain" />
        ) : (
          <div className="flex h-48 items-center justify-center text-[12px] text-neutral-500">
            {t('waiting')}
          </div>
        )}
      </div>
    </div>
  )
}
