import type {
  FlakeIndex as WireFlakeIndex,
  GateAudit as WireGateAudit,
  OpsReport as WireOpsReport,
} from '@everdict/contracts'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
//
// The load-bearing part of all three shapes is ABSENCE: a rate whose denominator was zero is absent, never
// 0% — the UI must render "not measured", never a zero bar.

export const opsReportSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  batches: z.object({
    total: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    cancelled: z.number(),
    superseded: z.number(),
  }),
  cases: z.object({
    executed: z.number(),
    gradeable: z.number(),
    verdicted: z.number(),
    passed: z.number(),
    failed: z.number(),
    infraFailed: z.number(),
    cancelled: z.number(),
    unmeasured: z.number(),
    requested: z.number().optional(),
  }),
  rates: z.object({
    infraFailure: z.number().optional(),
    unmeasured: z.number().optional(),
    traceComplete: z.number().optional(),
  }),
  evidence: z.object({
    trace: z.object({
      complete: z.number(),
      partial: z.number(),
      missing: z.number(),
      deferred: z.number(),
    }),
    snapshot: z.object({ complete: z.number(), missing: z.number() }),
  }),
})
export type OpsReport = z.infer<typeof opsReportSchema>

export const gateAuditSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  decisions: z.object({
    total: z.number(),
    pass: z.number(),
    block: z.number(),
    notComparable: z.number(),
  }),
  overrides: z.object({
    count: z.number(),
    entries: z.array(
      z.object({
        candidate: z.string(),
        gateId: z.string(),
        baseline: z.string(),
        by: z.string(),
        reason: z.string(),
        at: z.string(),
      })
    ),
  }),
  overrideRate: z.number().optional(),
})
export type GateAudit = z.infer<typeof gateAuditSchema>

export const flakeIndexSchema = z.object({
  entries: z.array(
    z.object({
      caseId: z.string(),
      harness: z.string(),
      runtime: z.string().optional(),
      observations: z.number(),
      passes: z.number(),
      failures: z.number(),
      flakeScore: z.number(),
    })
  ),
  observedKeys: z.number(),
})
export type FlakeIndex = z.infer<typeof flakeIndexSchema>

// Compile-time drift guards — a wire rename/retype on the control plane fails this typecheck.
type AssertAssignable<A extends B, B> = A
type _OpsReportGuard = AssertAssignable<OpsReport, WireOpsReport>
type _OpsReportGuardBack = AssertAssignable<WireOpsReport, OpsReport>
type _GateAuditGuard = AssertAssignable<GateAudit, WireGateAudit>
type _GateAuditGuardBack = AssertAssignable<WireGateAudit, GateAudit>
type _FlakeGuard = AssertAssignable<FlakeIndex, WireFlakeIndex>
type _FlakeGuardBack = AssertAssignable<WireFlakeIndex, FlakeIndex>
