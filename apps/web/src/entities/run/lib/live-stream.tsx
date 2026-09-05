'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// The multiplexed live stream (④) — the run detail's live section receives lane deltas over ONE SSE connection and feeds them to the widgets.
// A widget rests its own polling while the stream is attached, and falls back to its existing polling when there is no provider or the stream
// fails (connected=false) — it is a pure addition, so the screen draws exactly as it always did even when the stream dies.
export interface RunLiveStreamState {
  connected: boolean
  status?: string
  screenDataUrl?: string
  fsFiles?: Array<{ path: string; status?: 'modified' | 'added' | 'deleted' }>
  fsTruncated?: boolean
}

const RunLiveStreamContext = createContext<RunLiveStreamState | undefined>(undefined)

// The widget-side consumption hook — outside the provider (mounted alone on another screen) undefined means "no stream, poll".
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
  lanes: string // the lanes to request from the server (e.g. "screen,fs") — only what the consumers actually draw
  initialStatus?: string
  children: ReactNode
}) {
  const [state, setState] = useState<RunLiveStreamState>({ connected: false })

  useEffect(() => {
    // A run that has already finished has its stream closed immediately with `end` — there is no need even to open it.
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
      // The last state is kept — `connected` stays true so the widgets do not revive their polling (a finished run has nothing to poll).
      setState((s) => ({ ...s, status }))
      es.close()
    })
    es.onerror = () => {
      // One failure hands this mount over to the fallback polling — a retry loop overlapping the polling is the worst outcome.
      es.close()
      setState((s) => ({ ...s, connected: false }))
    }
    return () => es.close()
  }, [runId, lanes, initialStatus])

  return <RunLiveStreamContext.Provider value={state}>{children}</RunLiveStreamContext.Provider>
}
