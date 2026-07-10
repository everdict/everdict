import type { RunUsageSummary, RunStatus as WireRunStatus } from '@everdict/contracts'
import type { RunDetailResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4). The EXPORTED types are anchored to @everdict/contracts (re-architecture
// P4): the wire DTO is the type SSOT for the run's FLAT fields, so this local schema can no longer silently drift from
// the control plane on them. `import type` only — the zod v3 wire schemas never run in the web.
//
// Posture: the flat run fields (id/tenant/harness/caseId/status/error/trigger/parentScorecardId/liveTrace/timestamps)
// are sourced from the wire type and drift-guarded. `result`/`usage`/`Score`/`TraceEvent` stay a DELIBERATELY LOOSE
// consumer view — the UI parses trace events and snapshots by kind defensively (passthrough) so it survives server-side
// trace-kind/snapshot-kind additions, and renders `Score.detail` as text. Binding those to the strict wire shapes
// (`CaseResult`'s discriminated-union trace/snapshot, `Score.detail: unknown`) would force every consumer to re-narrow
// the unions. So they keep local types, drift-guarded only where they overlap the wire (Score/Usage numeric fields).

export const scoreSchema = z.object({
  graderId: z.string(),
  metric: z.string(),
  value: z.number(),
  pass: z.boolean().optional(),
  detail: z.string().optional(),
})
export type Score = z.infer<typeof scoreSchema>

// Trace events vary in shape per kind → parse loosely (passthrough) and branch in the UI.
export const traceEventSchema = z.object({ t: z.number(), kind: z.string() }).passthrough()
export type TraceEvent = z.infer<typeof traceEventSchema>

export const resultSchema = z
  .object({
    scores: z.array(scoreSchema).default([]),
    trace: z.array(traceEventSchema).default([]),
    // os-use=desktop snapshot (screenshot=base64 PNG inline in dev / screenshotRef=object storage URL offload → <img>).
    // browser=service-topology (browser-use, etc.) snapshot: url=final visited URL, dom=extracted text/DOM excerpt.
    snapshot: z
      .object({
        kind: z.string(),
        screenshot: z.string().optional(),
        screenshotRef: z.string().optional(),
        url: z.string().optional(),
        dom: z.string().optional(),
      })
      .passthrough()
      .optional(),
    harness: z.string().optional(),
  })
  .partial()

// Usage summary — the control plane derives it from result.trace (usageFromTrace). The activity list shows cost/tokens without parsing the trace.
export const usageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  usd: z.number(),
  calls: z.number(),
})
export type Usage = z.infer<typeof usageSchema>

export const runSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  harness: z.object({ id: z.string(), version: z.string() }),
  caseId: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  result: resultSchema.optional(),
  usage: usageSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  // provenance (activity view source axis): web|mcp|api|scorecard|schedule|front-door… unset=direct API.
  trigger: z.string().optional(),
  // the scorecard batch this run belongs to (if any). The control plane excludes children (where set) from the activity list by default.
  parentScorecardId: z.string().optional(),
  // live trace deep-link (derived, present only while active + the harness exports a platform trace)
  liveTrace: z.object({ kind: z.string(), endpoint: z.string(), runId: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const runsSchema = z.array(runSchema)

// The exported Run = the wire DTO's FLAT fields + the web's loose `result`/`usage` view. Deleting the flat-field mirror
// is the win: id/harness/status/liveTrace/trigger/… now come from the contract, so a wire rename breaks the web build.
type WireRunFlat = Omit<RunDetailResponse, 'result' | 'usage'>
export type Run = WireRunFlat & {
  result?: z.infer<typeof resultSchema>
  usage?: z.infer<typeof usageSchema>
}
export type RunStatus = WireRunStatus

// Drift guards — the local schema's flat output MUST stay assignable to the wire DTO (minus the loose result/usage).
// Run is NOT identical-shape: the web deliberately omits some optional wire fields (caseSpec/createdBy/runtime), so the
// guard can't be a full bidirectional equality like `view`. Instead:
//   _flatGuard   — web ⊆ wire: catches a required-field retype/rename or an enum widening (the `748eecb` host-bug class).
//   _webFieldsOnWire — every field the web DOES model must exist on the wire with an assignable type (Pick the wire down
//                      to the web's keys, require it back-assignable): catches renaming an OPTIONAL wire field the web
//                      models (which _flatGuard alone misses, since dropping an optional field stays assignable).
type AssertAssignable<A extends B, B> = A
type WebRun = z.infer<typeof runSchema>
type WebRunFlat = Omit<WebRun, 'result' | 'usage'>
type _flatGuard = AssertAssignable<WebRunFlat, WireRunFlat>
type _webFieldsOnWire = AssertAssignable<Pick<WireRunFlat, keyof WebRunFlat>, WebRunFlat>
type _statusGuard = AssertAssignable<WebRun['status'], WireRunStatus>
// The web Usage stays local (numbers instead of the wire's nonnegative-int brand), but its shape can't drift from the
// wire summary: the web keys must be exactly the wire keys (record-typed both ways).
type _usageKeysMatch = AssertAssignable<keyof z.infer<typeof usageSchema>, keyof RunUsageSummary> &
  AssertAssignable<keyof RunUsageSummary, keyof z.infer<typeof usageSchema>>

export type __runDriftGuard = [_flatGuard, _webFieldsOnWire, _statusGuard, _usageKeysMatch]
