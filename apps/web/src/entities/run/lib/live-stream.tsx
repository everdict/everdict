'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// 멀티플렉스 라이브 스트림(④) — run 상세의 라이브 섹션이 SSE 한 연결로 레인 델타를 받아 위젯에 공급한다.
// 위젯은 스트림이 붙어 있으면 자기 폴링을 쉬고, 프로바이더가 없거나 스트림이 실패하면(connected=false)
// 기존 폴링 폴백을 그대로 쓴다 — 순수 추가라 스트림이 죽어도 화면은 늘 그리던 대로 그린다.
export interface RunLiveStreamState {
  connected: boolean
  status?: string
  screenDataUrl?: string
  fsFiles?: Array<{ path: string; status?: 'modified' | 'added' | 'deleted' }>
  fsTruncated?: boolean
}

const RunLiveStreamContext = createContext<RunLiveStreamState | undefined>(undefined)

// 위젯 쪽 소비 훅 — 프로바이더 밖(다른 화면에 단독 마운트)에서는 undefined = "스트림 없음, 폴링해라".
export function useRunLiveStream(): RunLiveStreamState | undefined {
  return useContext(RunLiveStreamContext)
}

const TERMINAL = new Set(['succeeded', 'failed', 'superseded'])

export function RunLiveStreamProvider({
  runId,
  lanes,
  initialStatus,
  children,
}: {
  runId: string
  lanes: string // 서버에 요청할 레인들 (예: "screen,fs") — 소비자가 실제 그리는 것만
  initialStatus?: string
  children: ReactNode
}) {
  const [state, setState] = useState<RunLiveStreamState>({ connected: false })

  useEffect(() => {
    // 이미 끝난 run 은 스트림이 즉시 end 로 닫힌다 — 열 필요조차 없다.
    if (initialStatus && TERMINAL.has(initialStatus)) return
    const es = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/live/stream?lanes=${encodeURIComponent(lanes)}`
    )
    es.onopen = () => setState((s) => ({ ...s, connected: true }))
    es.addEventListener('status', (e) => {
      const { status } = JSON.parse((e as MessageEvent).data) as { status: string }
      setState((s) => ({ ...s, status }))
    })
    es.addEventListener('screen', (e) => {
      const { dataUrl } = JSON.parse((e as MessageEvent).data) as { dataUrl: string }
      setState((s) => ({ ...s, screenDataUrl: dataUrl }))
    })
    es.addEventListener('fs', (e) => {
      const body = JSON.parse((e as MessageEvent).data) as {
        files: RunLiveStreamState['fsFiles']
        truncated: boolean
      }
      setState((s) => ({ ...s, fsFiles: body.files, fsTruncated: body.truncated }))
    })
    es.addEventListener('end', (e) => {
      const { status } = JSON.parse((e as MessageEvent).data) as { status: string }
      // 마지막 상태는 남긴다 — connected 는 유지해 위젯이 폴링을 되살리지 않게 (끝난 run 은 폴 것도 없다).
      setState((s) => ({ ...s, status }))
      es.close()
    })
    es.onerror = () => {
      // 한 번이라도 실패하면 이 마운트 동안은 폴백 폴링에 맡긴다 — 재시도 루프가 폴링과 겹치는 것이 최악.
      es.close()
      setState((s) => ({ ...s, connected: false }))
    }
    return () => es.close()
  }, [runId, lanes, initialStatus])

  return <RunLiveStreamContext.Provider value={state}>{children}</RunLiveStreamContext.Provider>
}
