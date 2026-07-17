import type { SpanAttrMapping } from '@everdict/contracts'

// The SpanAttrMapping timeline fields, in editor order — each maps a TraceEvent field to a harness's own
// span-attribute keys. (Kept local to entities/trace so the judge wizard reuses it without depending on the
// register-harness feature.)
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

// The evidence slots — extract judge evidence (final answer / final DOM / screenshot) from the trace itself.
// Rendered as a separate builder group; no built-in defaults (empty slot = that evidence stays absent).
export const EVIDENCE_MAPPING_FIELDS = ['finalAnswer', 'dom', 'screenshot'] as const
export type EvidenceMappingField = (typeof EVIDENCE_MAPPING_FIELDS)[number]

const ALL_FIELDS = [...SPAN_MAPPING_FIELDS, ...EVIDENCE_MAPPING_FIELDS] as const

// Editor form model: field → comma-separated attribute keys (what the builder assembles).
export type SpanMappingRecord = Record<SpanMappingField | EvidenceMappingField, string>

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
  finalAnswer: '',
  dom: '',
  screenshot: '',
}

// Comma-separated form record → the SpanAttrMapping spec (arrays; empty fields omitted). undefined when nothing is set.
export function mappingRecordToSpec(rec: SpanMappingRecord): SpanAttrMapping | undefined {
  const out: SpanAttrMapping = {}
  for (const f of ALL_FIELDS) {
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
  for (const f of ALL_FIELDS) {
    const keys = spec[f]
    if (keys && keys.length > 0) rec[f] = keys.join(', ')
  }
  return rec
}
