'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded'])

// 라이브 화면 — 실행 중인 케이스의 현재 프레임을 2초마다 폴링해 <img>로 보여준다. 프레임 출처 3종: os-use scrot ·
// 브라우저 토폴로지 CDP 캡처 · self-hosted 러너가 자기 컨테이너 화면(browser-use Chromium 등)을 밀어 넣은 프레임.
// 프레임이 생길 때까지는 아무것도 렌더하지 않아(라이브 화면 없는 run은 안 보임), 첫 프레임 지연에도 폴링을 포기하지
// 않는다. run이 종료(terminal)되면 폴링을 멈추고 마지막 프레임을 그대로 둔다.
export function LiveScreen({ runId, initialStatus }: { runId: string; initialStatus?: string }) {
  const t = useTranslations('liveScreen')
  const [src, setSrc] = useState('')
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    if (initialStatus && TERMINAL.has(initialStatus)) return
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
  }, [runId, initialStatus])

  // 라이브 화면이 없는 run(또는 아직 첫 프레임 전) — 빈 박스 대신 통째로 숨긴다.
  if (!supported && !src) return null
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
