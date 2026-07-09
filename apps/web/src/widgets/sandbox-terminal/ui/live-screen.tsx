'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

// Live screen view (observability ⑤) — polls the case's current screenshot (os-use desktop) every 2s into an
// <img> while the run is active. supported=false for non-desktop env kinds (the component renders nothing).
export function LiveScreen({ runId }: { runId: string }) {
  const t = useTranslations('liveScreen')
  const [src, setSrc] = useState('')
  const [state, setState] = useState<'loading' | 'supported' | 'unsupported'>('loading')

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/screen`)
        if (res.ok) {
          const body = (await res.json()) as { supported: boolean; found: boolean; dataUrl: string }
          if (stopped) return
          if (!body.supported) {
            setState('unsupported')
            return // no point polling a non-desktop run
          }
          setState('supported')
          if (body.found) setSrc(body.dataUrl)
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
  }, [runId])

  if (state === 'unsupported') return null
  return (
    <div className="space-y-1.5">
      <span className="text-[11.5px] text-faint">{t('label')}</span>
      <div className="overflow-hidden rounded-lg border border-border bg-black">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={t('label')} className="max-h-[28rem] w-full object-contain" />
        ) : (
          <div className="flex h-48 items-center justify-center text-[12px] text-neutral-500">
            {t('waiting')}
          </div>
        )}
      </div>
    </div>
  )
}
