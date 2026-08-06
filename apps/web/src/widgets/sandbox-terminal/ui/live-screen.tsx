'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { useRunLiveStream } from '@/entities/run'
import { BrowserCanvas } from '@/features/interactive-browser'
import { Button } from '@/shared/ui/button'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded'])

// 라이브 화면 — 실행 중인 케이스의 현재 프레임을 2초마다 폴링해 <img>로 보여준다. 프레임 출처 3종: os-use scrot ·
// 브라우저 토폴로지 CDP 캡처 · self-hosted 러너가 자기 컨테이너 화면(browser-use Chromium 등)을 밀어 넣은 프레임.
// 프레임이 생길 때까지는 아무것도 렌더하지 않아(라이브 화면 없는 run은 안 보임), 첫 프레임 지연에도 폴링을 포기하지
// 않는다. run이 종료(terminal)되면 폴링을 멈추고 마지막 프레임을 그대로 둔다.
export function LiveScreen({ runId, initialStatus }: { runId: string; initialStatus?: string }) {
  const t = useTranslations('liveScreen')
  const [src, setSrc] = useState('')
  const [supported, setSupported] = useState(false)
  const [driving, setDriving] = useState(false)
  // 멀티플렉스 스트림(④)이 붙어 있으면 프레임은 거기서 온다 — 이 위젯의 2초 폴링은 폴백으로만 산다.
  const stream = useRunLiveStream()
  const streamed = stream?.connected ? stream.screenDataUrl : undefined

  useEffect(() => {
    if (initialStatus && TERMINAL.has(initialStatus)) return
    if (stream?.connected) return // 스트림이 프레임을 밀어주는 동안 폴링은 쉰다
    if (driving) return // 제어 중에는 스크린캐스트가 화면을 대신한다 — 폴링을 겹치면 같은 브라우저를 두 번 긁는다
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

  // 스트림 프레임이 있으면 그것이 최신 — 폴링 프레임은 폴백. 라이브 화면이 없는 run 은 통째로 숨긴다.
  const effSrc = streamed ?? src
  if (!supported && !effSrc) return null

  // 제어 모드 — 보는 것에서 하는 것으로. 케이스가 로그인 벽·캡차에 막혔을 때 사람이 직접 넘겨주는 통로라,
  // 붙는 순간 폴링 이미지 대신 실제 브라우저(스크린캐스트+입력)로 바뀐다.
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
