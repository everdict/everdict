import type { TraceEvent } from '../model/schema'

// Agent-plane trace helpers — shared by the replay player's agent lane (widgets/replay-player) and the
// playground's live trace list (features/harness-playground). Both render a TraceEvent[] as one-line rows
// while it is still streaming; FSD forbids widget→widget imports, so the shared summary/colour lives here.
// The SETTLED evidence is a different surface: TrajectoryView (features/browse-traces) reads the sealed
// trajectory in full — these helpers are for the live/compact lanes only.

// A single trace event → a one-line human summary (role/model/tool call/result/error/log).
export function summarizeTraceEvent(e: TraceEvent): string {
  const a = e as Record<string, unknown>
  switch (e.kind) {
    case 'message':
      return `${String(a.role ?? '')}: ${String(a.text ?? '').slice(0, 140)}`
    case 'llm_call': {
      const cost = a.cost as { usd?: number } | undefined
      return `model ${String(a.model ?? '')}${cost?.usd != null ? ` · $${cost.usd}` : ''}`
    }
    case 'tool_call':
      return `${String(a.name ?? '')}(${JSON.stringify(a.args ?? {}).slice(0, 80)})`
    case 'tool_result':
      return `→ ${a.ok ? 'ok' : 'fail'} ${String(a.output ?? '').slice(0, 80)}`
    case 'error':
      return String(a.message ?? '')
    case 'log':
      return `[${String(a.stream ?? '')}] ${String(a.text ?? '').slice(0, 140)}`
    case 'infra': {
      // 인프라 플레인 기록(배치/서비스) — [scope/service] event: message (node)
      const head = a.service
        ? `${String(a.scope ?? '')}/${String(a.service)}`
        : String(a.scope ?? '')
      const event = a.event ? `${String(a.event)}: ` : ''
      const node = a.node ? ` @${String(a.node)}` : ''
      return `[${head}] ${event}${String(a.message ?? '').slice(0, 140)}${node}`
    }
    default:
      return ''
  }
}

// Tailwind background token per trace kind — the timeline dot and the replay lane marker.
const TRACE_KIND_COLOR: Record<string, string> = {
  message: 'bg-muted-foreground',
  llm_call: 'bg-primary',
  tool_call: 'bg-[var(--color-success)]',
  tool_result: 'bg-[var(--color-success)]',
  env_action: 'bg-accent-foreground',
  error: 'bg-destructive',
  log: 'bg-border',
  infra: 'bg-accent-foreground',
}

export function traceKindColor(kind: string): string {
  return TRACE_KIND_COLOR[kind] ?? 'bg-muted-foreground'
}
