import type { EvidenceSlot, SpanAttrMapping } from '@everdict/contracts'

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

// Editor form model for the timeline fields: field → comma-separated attribute keys.
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

// The FIXED evidence slots — extract judge evidence (final answer / final DOM / screenshot) from the trace itself.
// Custom slot names (the judge template's {<name>} placeholders) live beside them in the same form record.
export const FIXED_EVIDENCE_SLOTS = ['finalAnswer', 'dom', 'screenshot'] as const
export type FixedEvidenceSlot = (typeof FIXED_EVIDENCE_SLOTS)[number]

// One evidence binding — an observed attr key, optionally a dot/bracket path INTO its JSON value.
export interface EvidenceBindingForm {
  key: string
  path?: string
}
// slot name (fixed or custom) → ordered bindings (first that resolves wins).
export type EvidenceSlotsForm = Record<string, EvidenceBindingForm[]>

export const EMPTY_EVIDENCE_SLOTS: EvidenceSlotsForm = { finalAnswer: [], dom: [], screenshot: [] }

const isFixed = (name: string): name is FixedEvidenceSlot =>
  (FIXED_EVIDENCE_SLOTS as readonly string[]).includes(name)

function bindingsToSlot(bindings: EvidenceBindingForm[]): EvidenceSlot {
  // a pathless binding stays a bare string on the wire (back-compat with plain attr-key lists)
  return bindings.map((b) => (b.path ? { key: b.key, path: b.path } : b.key))
}

// Form state (timeline record + evidence slots) → the SpanAttrMapping spec. undefined when nothing is set.
export function mappingRecordToSpec(
  rec: SpanMappingRecord,
  slots: EvidenceSlotsForm = EMPTY_EVIDENCE_SLOTS
): SpanAttrMapping | undefined {
  const out: SpanAttrMapping = {}
  for (const f of SPAN_MAPPING_FIELDS) {
    const keys = (rec[f] ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0)
    if (keys.length > 0) out[f] = keys
  }
  const custom: Record<string, EvidenceSlot> = {}
  for (const [name, bindings] of Object.entries(slots)) {
    if (bindings.length === 0) continue
    if (isFixed(name)) out[name] = bindingsToSlot(bindings)
    else custom[name] = bindingsToSlot(bindings)
  }
  if (Object.keys(custom).length > 0) out.evidence = custom
  return Object.keys(out).length > 0 ? out : undefined
}

function slotToBindings(slot: EvidenceSlot | undefined): EvidenceBindingForm[] {
  return (slot ?? []).map((entry) =>
    typeof entry === 'string'
      ? { key: entry }
      : { key: entry.key, ...(entry.path ? { path: entry.path } : {}) }
  )
}

// SpanAttrMapping spec → the form state (for editing a stored overlay).
export function mappingSpecToRecord(spec: SpanAttrMapping | null | undefined): {
  record: SpanMappingRecord
  slots: EvidenceSlotsForm
} {
  const record = { ...EMPTY_SPAN_MAPPING }
  const slots: EvidenceSlotsForm = { finalAnswer: [], dom: [], screenshot: [] }
  if (!spec) return { record, slots }
  for (const f of SPAN_MAPPING_FIELDS) {
    const keys = spec[f]
    if (keys && keys.length > 0) record[f] = keys.join(', ')
  }
  for (const name of FIXED_EVIDENCE_SLOTS) slots[name] = slotToBindings(spec[name])
  for (const [name, slot] of Object.entries(spec.evidence ?? {})) slots[name] = slotToBindings(slot)
  return { record, slots }
}
