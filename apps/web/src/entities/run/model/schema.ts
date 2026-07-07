import { z } from 'zod'

// Client mirror of the control plane RunRecord. The web couples over HTTP only — no backend package dependency.
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
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Run = z.infer<typeof runSchema>
export type RunStatus = Run['status']

export const runsSchema = z.array(runSchema)
