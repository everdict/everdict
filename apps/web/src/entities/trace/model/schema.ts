import type {
  SpanAttrMapping,
  SpanAttrSample,
  TraceEvidence,
  TraceSummary,
} from '@everdict/contracts'
import { z } from 'zod'

// Client mirror of the observability trace types (list/inspect surfaces of the trace-source browser + judge wizard).
// Runtime boundary validation stays here (zod v4); EXPORTED types anchor to @everdict/contracts (re-architecture P4,
// `import type` only). Every schema carries a compile-time drift guard so a wire retype fails the web typecheck.

// One normalized trace event (the inspect timeline). Mirrors the contracts TraceEvent discriminated union.
export const traceCostSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  usd: z.number(),
})
export const traceEventSchema = z.discriminatedUnion('kind', [
  z.object({
    t: z.number(),
    kind: z.literal('message'),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
  }),
  z.object({
    t: z.number(),
    kind: z.literal('llm_call'),
    model: z.string(),
    cost: traceCostSchema.optional(),
    latencyMs: z.number().optional(),
  }),
  z.object({
    t: z.number(),
    kind: z.literal('tool_call'),
    id: z.string(),
    name: z.string(),
    args: z.unknown(),
  }),
  z.object({
    t: z.number(),
    kind: z.literal('tool_result'),
    id: z.string(),
    ok: z.boolean(),
    output: z.string(),
  }),
  z.object({
    t: z.number(),
    kind: z.literal('env_action'),
    action: z.string(),
    detail: z.unknown().optional(),
  }),
  z.object({ t: z.number(), kind: z.literal('error'), message: z.string() }),
  z.object({
    t: z.number(),
    kind: z.literal('log'),
    stream: z.enum(['stdout', 'stderr']),
    text: z.string(),
  }),
  z.object({
    t: z.number(),
    kind: z.literal('artifact'),
    name: z.string(),
    ref: z.string(),
    mediaType: z.string().optional(),
    role: z.string().optional(),
  }),
  z.object({
    t: z.number(),
    kind: z.literal('span'),
    name: z.string(),
    attributes: z.record(z.string(), z.unknown()).optional(),
  }),
])

// A trace list row — id + observability metrics the platform reports for a whole trace (everything but id best-effort).
export const traceSummarySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  startedAt: z.string().optional(),
  durationMs: z.number().optional(),
  status: z.enum(['ok', 'error', 'unset']).optional(),
  tokens: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
  costUsd: z.number().optional(),
  llmModel: z.string().optional(),
  spanCount: z.number().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  scope: z.string().optional(),
})
export const tracesListResponseSchema = z.object({ traces: z.array(traceSummarySchema) })

// One span's raw attributes (span-based kinds) — the keys a user maps in the wizard's conversion editor.
export const spanAttrSampleSchema = z.object({
  spanName: z.string(),
  attrs: z.record(z.string(), z.unknown()),
})

// One waterfall node — the structured span the detail dialog renders (offset/duration/type/io/tokens/cost).
export const traceSpanNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  name: z.string(),
  type: z.enum(['agent', 'llm', 'tool', 'retriever', 'chain', 'span']),
  startOffsetMs: z.number(),
  durationMs: z.number(),
  attributes: z.record(z.string(), z.unknown()),
  input: z.string().optional(),
  output: z.string().optional(),
  model: z.string().optional(),
  tokens: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
  costUsd: z.number().optional(),
})

// Judge evidence extracted from a trace via the mapping's evidence slots (finalAnswer/dom/screenshot + custom
// named slots) — the wizard relays it into the preview (synthesized browser snapshot + custom placeholders).
export const traceEvidenceSchema = z.object({
  finalAnswer: z.string().optional(),
  dom: z.string().optional(),
  screenshotRef: z.string().optional(),
  screenshot: z.string().optional(),
  screenshotMediaType: z.string().optional(),
  custom: z.record(z.string(), z.string()).optional(),
})

// inspect(traceId, mapping) result — normalized events (with the supplied mapping) + raw span attributes + (best-effort)
// the structured `detail` (rollups + span waterfall) the observability-grade detail dialog renders.
export const traceInspectResultSchema = z.object({
  rawAttributes: z.array(spanAttrSampleSchema).optional(),
  events: z.array(traceEventSchema),
  evidence: traceEvidenceSchema.optional(),
  detail: z
    .object({
      rollup: traceSummarySchema.omit({ id: true }).optional(),
      spans: z.array(traceSpanNodeSchema),
    })
    .optional(),
})

// One evidence selector — an attr key + an optional dot/bracket path INTO its JSON value. A bare string = { key }.
export const evidenceSelectorSchema = z.object({
  key: z.string(),
  path: z.string().optional(),
  pick: z.enum(['last', 'first']).optional(),
})
export const evidenceSlotSchema = z.array(z.union([z.string(), evidenceSelectorSchema]))

// The per-field span-attribute mapping — the conversion layer between a harness's spans and the judge's TraceEvents.
// The evidence slots (finalAnswer/dom/screenshot + the free-form `evidence` record) extract judge evidence from the
// trace itself (no defaults); custom names become the judge template's {<name>} placeholders.
export const spanAttrMappingSchema = z.object({
  model: z.array(z.string()).optional(),
  inputTokens: z.array(z.string()).optional(),
  outputTokens: z.array(z.string()).optional(),
  costUsd: z.array(z.string()).optional(),
  toolName: z.array(z.string()).optional(),
  toolCallId: z.array(z.string()).optional(),
  toolArgs: z.array(z.string()).optional(),
  toolResult: z.array(z.string()).optional(),
  messageText: z.array(z.string()).optional(),
  finalAnswer: evidenceSlotSchema.optional(),
  dom: evidenceSlotSchema.optional(),
  screenshot: evidenceSlotSchema.optional(),
  evidence: z.record(z.string(), evidenceSlotSchema).optional(),
})

// Drift guards — a wire rename/retype fails the web typecheck (bidirectional where identical-shape). The event/inspect
// shapes are a DELIBERATELY-LOOSE consumer view: zod v4 infers an `unknown` object key (tool_call.args / env_action.detail)
// as OPTIONAL, which the zod v3 contract does not — so they are hand-mirrored for rendering but not bidirectionally
// bound. The clean shapes (summary / sample / mapping — no bare `unknown` keys) ARE bound both ways.
type AssertAssignable<A extends B, B> = A
type _summaryFwd = AssertAssignable<z.infer<typeof traceSummarySchema>, TraceSummary>
type _summaryBack = AssertAssignable<TraceSummary, z.infer<typeof traceSummarySchema>>
type _sampleFwd = AssertAssignable<z.infer<typeof spanAttrSampleSchema>, SpanAttrSample>
type _sampleBack = AssertAssignable<SpanAttrSample, z.infer<typeof spanAttrSampleSchema>>
type _mappingFwd = AssertAssignable<z.infer<typeof spanAttrMappingSchema>, SpanAttrMapping>
type _mappingBack = AssertAssignable<SpanAttrMapping, z.infer<typeof spanAttrMappingSchema>>
type _evidenceFwd = AssertAssignable<z.infer<typeof traceEvidenceSchema>, TraceEvidence>
type _evidenceBack = AssertAssignable<TraceEvidence, z.infer<typeof traceEvidenceSchema>>

export type __traceDriftGuard = [
  _summaryFwd,
  _summaryBack,
  _sampleFwd,
  _sampleBack,
  _mappingFwd,
  _mappingBack,
  _evidenceFwd,
  _evidenceBack,
]
