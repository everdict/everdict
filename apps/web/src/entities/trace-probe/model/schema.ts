import type {
  TraceProbeResult as WireTraceProbeResult,
  TraceScopeOption as WireTraceScopeOption,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// Client mirror of the control-plane /workspace/trace-{sources,sinks}/probe response — a connection test +
// scope discovery outcome. Runtime boundary validation stays here (zod v4); the EXPORTED types anchor to
// @everdict/contracts/wire (re-architecture P4). `import type` only — the wire zod schema never runs in the web.
export const traceScopeOptionSchema = z.object({
  id: z.string(), // value stored on the source/sink config (mlflow experiment_id · phoenix/langsmith project id · otel service)
  name: z.string(), // human label shown in the scope picker
})

export const traceProbeResultSchema = z.object({
  kind: z.string(),
  reachable: z.boolean(),
  detail: z.string(),
  reason: z.enum(['auth', 'unreachable', 'error']).optional(),
  scopeKind: z.enum(['experiment', 'project', 'service']).optional(),
  scopes: z.array(traceScopeOptionSchema).optional(), // present (possibly empty) only when reachable
})

// Drift guards — identical-shape, so bidirectional: a wire rename/retype fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebProbe = z.infer<typeof traceProbeResultSchema>
type WebScope = z.infer<typeof traceScopeOptionSchema>
type _probeFwd = AssertAssignable<WebProbe, WireTraceProbeResult>
type _probeBack = AssertAssignable<WireTraceProbeResult, WebProbe>
type _scopeFwd = AssertAssignable<WebScope, WireTraceScopeOption>
type _scopeBack = AssertAssignable<WireTraceScopeOption, WebScope>
export type __traceProbeDriftGuard = [_probeFwd, _probeBack, _scopeFwd, _scopeBack]

// Exported names alias the contract types (consumers stay anchored to the wire surface).
export type TraceProbeResult = WireTraceProbeResult
export type TraceScopeOption = WireTraceScopeOption
export type TraceScopeKind = NonNullable<WireTraceProbeResult['scopeKind']>
