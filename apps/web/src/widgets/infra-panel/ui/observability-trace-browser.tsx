'use client'

import { TraceBrowser } from '@/features/browse-traces'
import type { TraceSummary } from '@/entities/trace'
import type { TraceSourceConfig } from '@/entities/trace-source'

import { useMentionInChat } from '../model/infra-panel-context'

// The Settings › Observability trace browser, wired to "analyze in chat": a trace's detail dialog offers a button that
// drops that trace into the agent chat as context (a `trace` reference keyed by (source, id) → the agent inspects it).
// Lives in the widget layer so the features-layer browser stays free of the infra-panel wiring (widgets → features is
// the allowed direction; the reverse would be an FSD violation). Auto-load stays off — the browse is user-driven Fetch.
export function ObservabilityTraceBrowser({
  sources,
  deepLink,
}: {
  sources: TraceSourceConfig[]
  // The ?source=&trace= deep-link pair the settings page read server-side — passed through so the browser
  // mirrors its dialog into the URL and self-opens a shared trace. See TraceBrowser's prop for the contract.
  deepLink?: { source?: string; traceId?: string }
}) {
  const mention = useMentionInChat()
  return (
    <TraceBrowser
      sources={sources}
      autoLoad={false}
      {...(deepLink ? { deepLink } : {})}
      onMention={(trace: TraceSummary, sourceName: string) =>
        mention({ type: 'trace', id: trace.id, source: sourceName, label: trace.name ?? trace.id })
      }
    />
  )
}
