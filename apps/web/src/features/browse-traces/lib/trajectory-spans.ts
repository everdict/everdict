import type { TraceEvent, TraceSpanNode } from '@/entities/trace'

import type { PlacedEvent } from './trajectory-planes'

// The owned trajectory, read as the SAME thing an external platform's trace is: a span tree.
//
// The two trace dialogs used to look nothing alike, and the renderer was never the reason — the DATA was. A
// platform's inspect answer is `TraceSpanNode[]` (id · parentId · offset · duration · attributes), which draws
// as an indented waterfall; our ledger holds a normalized `TraceEvent[]`, which for a long time carried a bare
// scalar `t` and no parentage, so it could only draw as a list. Now that events carry the contracts STRUCTURE
// (spanId / parentId / durationMs / at), this projection closes the gap: one renderer, both sources.
//
// What stays ours: the LANE axis (agent · placement · one per service), which a single-process platform trace
// has no equivalent for. The waterfall is shared; the swimlanes sit above it.

// Which node type an event reads as — the vocabulary the shared waterfall colors by (the platform's span
// types). A tool result is part of its call, so it keeps the tool hue rather than inventing an eleventh color.
function typeOf(event: TraceEvent): TraceSpanNode['type'] {
  switch (event.kind) {
    case 'llm_call':
      return 'llm'
    case 'tool_call':
    case 'tool_result':
      return 'tool'
    case 'message':
      return 'agent'
    case 'span':
      return 'span'
    default:
      return 'chain'
  }
}

// The row's name — short enough for a waterfall label, specific enough to point at ("the second bash call").
function nameOf(event: TraceEvent): string {
  switch (event.kind) {
    case 'message':
      return event.role
    case 'llm_call':
      return event.model === '' ? 'llm' : event.model
    case 'tool_call':
      return event.name
    case 'tool_result':
      return `${event.ok ? '' : '✗ '}result`
    case 'env_action':
      return event.action
    case 'error':
      return 'error'
    case 'log':
      return event.stream
    case 'artifact':
      return event.name
    case 'span':
      return event.name
    case 'infra':
      return event.event ?? 'infra'
  }
}

// The payload that reads as this node's INPUT / OUTPUT in the side panel. Same split the event detail uses —
// a message's text and a tool call's args are inputs; a result's output and an error's message are outputs.
function ioOf(event: TraceEvent): { input?: string; output?: string } {
  switch (event.kind) {
    case 'message':
      return event.role === 'user' ? { input: event.text } : { output: event.text }
    case 'tool_call':
      return event.args === undefined
        ? {}
        : { input: typeof event.args === 'string' ? event.args : safeJson(event.args) }
    case 'tool_result':
      return event.output === '' ? {} : { output: event.output }
    case 'error':
      return { output: event.message }
    case 'log':
      return { output: event.text }
    case 'env_action':
      return event.detail === undefined ? {} : { input: safeJson(event.detail) }
    case 'infra':
      return { output: event.message }
    default:
      return {}
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

// Everything scalar about the event — the attribute table. A `span`'s own attribute bag merges in verbatim
// (it IS one), so an ingested structural span finally shows what it was carrying.
function attributesOf(event: TraceEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    if (value === undefined) continue
    if (key === 'kind' || key === 't') continue // the identity strip already says both
    if (key === 'attributes' && typeof value === 'object' && value !== null) {
      for (const [ak, av] of Object.entries(value as Record<string, unknown>)) out[ak] = av
      continue
    }
    if (['text', 'args', 'output', 'message', 'detail'].includes(key)) continue // rendered in full above
    out[key] = value
  }
  return out
}

export interface TrajectorySpans {
  nodes: TraceSpanNode[]
  // node id → the event it came from, so a selected row can still be rendered as the rich EVENT it is
  // (every payload in full — evidence elided at 200 characters is not evidence).
  eventOf: Map<string, PlacedEvent>
}

// Project placed events onto waterfall nodes. `axisStart` is the absolute instant the shared axis begins at;
// an unanchored plane (no t0, no absolute stamp) falls back to the event's own relative `t`, which is what it
// means anyway — the picture is then relative rather than wall-clock, and the view says so.
export function trajectorySpans(placed: PlacedEvent[], axisStart?: number): TrajectorySpans {
  const eventOf = new Map<string, PlacedEvent>()
  const nodes: TraceSpanNode[] = []
  // Two events may claim the same node id only if an emitter repeats a span id; keep the first and let the
  // rest stand on their own key, so the tree never silently loses a step.
  const claimed = new Set<string>()
  for (const item of placed) {
    const id = claimed.has(item.nodeId) ? item.key : item.nodeId
    claimed.add(id)
    const event = item.event
    const startOffsetMs =
      item.startMs !== undefined && axisStart !== undefined ? item.startMs - axisStart : event.t
    const cost = event.kind === 'llm_call' ? event.cost : undefined
    nodes.push({
      id,
      ...(item.parentNodeId !== undefined ? { parentId: item.parentNodeId } : {}),
      name: nameOf(event),
      type: typeOf(event),
      startOffsetMs: Number.isFinite(startOffsetMs) ? startOffsetMs : 0,
      durationMs: item.durationMs,
      attributes: attributesOf(event),
      ...ioOf(event),
      ...(event.kind === 'llm_call' && event.model !== '' ? { model: event.model } : {}),
      ...(cost ? { tokens: { input: cost.inputTokens, output: cost.outputTokens } } : {}),
      ...(cost && cost.usd > 0 ? { costUsd: cost.usd } : {}),
    })
    eventOf.set(id, item)
  }
  return { nodes, eventOf }
}
