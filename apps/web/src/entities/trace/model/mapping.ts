import type { SpanAttrMapping } from '@everdict/contracts'

// The SpanAttrMapping fields, in editor order — each maps a TraceEvent field to a harness's own span-attribute keys.
// (Kept local to entities/trace so the judge wizard reuses it without depending on the register-harness feature.)
export const SPAN_MAPPING_FIELDS = [
  'model',
  'inputTokens',
  'outputTokens',
  'costUsd',
  'toolName',
  'toolCallId',
  'toolArgs',
  'toolResult',
  'messageText',
] as const
export type SpanMappingField = (typeof SPAN_MAPPING_FIELDS)[number]

// Editor form model: field → comma-separated attribute keys (what the user types).
export type SpanMappingRecord = Record<SpanMappingField, string>

export const EMPTY_SPAN_MAPPING: SpanMappingRecord = {
  model: '',
  inputTokens: '',
  outputTokens: '',
  costUsd: '',
  toolName: '',
  toolCallId: '',
  toolArgs: '',
  toolResult: '',
  messageText: '',
}

// Comma-separated form record → the SpanAttrMapping spec (arrays; empty fields omitted). undefined when nothing is set.
export function mappingRecordToSpec(rec: SpanMappingRecord): SpanAttrMapping | undefined {
  const out: SpanAttrMapping = {}
  for (const f of SPAN_MAPPING_FIELDS) {
    const keys = (rec[f] ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0)
    if (keys.length > 0) out[f] = keys
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// SpanAttrMapping spec → the comma-separated form record (for editing a stored overlay).
export function mappingSpecToRecord(spec: SpanAttrMapping | null | undefined): SpanMappingRecord {
  const rec = { ...EMPTY_SPAN_MAPPING }
  if (!spec) return rec
  for (const f of SPAN_MAPPING_FIELDS) {
    const keys = spec[f]
    if (keys && keys.length > 0) rec[f] = keys.join(', ')
  }
  return rec
}
