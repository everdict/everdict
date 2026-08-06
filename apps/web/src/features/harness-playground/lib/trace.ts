import type { TraceEvent } from '@/entities/run'

// Trace-derived card facts, shared by the case card and the conversation turn card. Trace events are a
// passthrough shape (the web parses them loosely by kind), so every field is read defensively.

// The harness's answer = the last assistant message in the trace.
export function finalAnswer(events: TraceEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.kind !== 'message') continue
    const fields = event as Record<string, unknown>
    if (fields.role !== 'assistant') continue
    const text = typeof fields.text === 'string' ? fields.text.trim() : ''
    if (text.length > 0) return text
  }
  return undefined
}

// What the case cost so far, summed from the harness's own llm_call events (the harness reports cost; we never
// price it ourselves). Undefined = this harness reports no cost, and the line is hidden rather than showing $0.
export function totalCostUsd(events: TraceEvent[]): number | undefined {
  let total = 0
  let reported = false
  for (const event of events) {
    if (event.kind !== 'llm_call') continue
    const cost = (event as Record<string, unknown>).cost
    if (cost === null || typeof cost !== 'object') continue
    const usd = (cost as Record<string, unknown>).usd
    if (typeof usd !== 'number' || !Number.isFinite(usd)) continue
    total += usd
    reported = true
  }
  return reported ? total : undefined
}

// The failure's own words when the harness emitted them — better than a generic banner.
export function failureMessage(events: TraceEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.kind !== 'error') continue
    const message = (event as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim().length > 0) return message.trim()
  }
  return undefined
}
