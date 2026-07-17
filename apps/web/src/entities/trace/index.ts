export {
  harnessSpanMappingResponseSchema,
  spanAttrMappingSchema,
  spanAttrSampleSchema,
  traceCostSchema,
  traceEventSchema,
  traceEvidenceSchema,
  traceInspectResultSchema,
  traceSummarySchema,
  tracesListResponseSchema,
} from './model/schema'
export {
  EMPTY_EVIDENCE_SLOTS,
  EMPTY_SPAN_MAPPING,
  FIXED_EVIDENCE_SLOTS,
  mappingRecordToSpec,
  mappingSpecToRecord,
  SPAN_MAPPING_FIELDS,
  type EvidenceBindingForm,
  type EvidenceSlotsForm,
  type FixedEvidenceSlot,
  type SpanMappingField,
  type SpanMappingRecord,
} from './model/mapping'
export { SpanMappingEditor, type SpanAttrOption } from './ui/span-mapping-editor'
// Exported types anchor to the contracts wire types (the local zod schemas are drift-guarded against these).
export type {
  SpanAttrMapping,
  SpanAttrSample,
  TraceEvent,
  TraceEvidence,
  TraceInspectResult,
  TraceSpanNode,
  TraceSummary,
} from '@everdict/contracts'
