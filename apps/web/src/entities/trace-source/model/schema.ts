import type { TraceSourceConfigView, TraceSourceRoster } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Client mirror of the control-plane /workspace/trace-sources response — workspace trace sources (pull a
// dev-cluster-deployed harness's trace for evaluation, multiple).
// No secrets: authSecretName is a SecretStore name reference, not a value. Auth values never reach the browser.
export const traceSourceKindSchema = z.enum(['otel', 'mlflow', 'langfuse', 'langsmith', 'phoenix'])

export const traceSourceConfigSchema = z.object({
  name: z.string(), // source identifier — the key for upsert/delete/per-harness selection (assignment)
  kind: traceSourceKindSchema,
  endpoint: z.string(),
  authSecretName: z.string().optional(),
  correlate: z.enum(['id', 'tag']), // id = everdict runId IS the trace id · tag = search the everdict.run_id the agent tagged
  service: z.string().optional(), // otel/jaeger tag-search scope (the agent's service.name)
  project: z.string().optional(), // per-kind coordinate: mlflow experiment_id (tag search) · phoenix project
})

// GET /workspace/trace-sources → { sources, assignments }; assignments = harness id → source name (per-harness selection).
export const traceSourcesResponseSchema = z.object({
  sources: z.array(traceSourceConfigSchema),
  assignments: z.record(z.string(), z.string()),
})

// Drift guards — both are identical-shape (config = every wire field; roster = sources + assignments), so the
// guards are bidirectional: a renamed/added field or a widened kind on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebTraceSourceConfig = z.infer<typeof traceSourceConfigSchema>
type WebTraceSourcesResponse = z.infer<typeof traceSourcesResponseSchema>
type _configFwd = AssertAssignable<WebTraceSourceConfig, TraceSourceConfigView>
type _configBack = AssertAssignable<TraceSourceConfigView, WebTraceSourceConfig>
type _rosterFwd = AssertAssignable<WebTraceSourcesResponse, TraceSourceRoster>
type _rosterBack = AssertAssignable<TraceSourceRoster, WebTraceSourcesResponse>

// Exported names alias the contract types (consumers untouched: same identifiers).
export type TraceSourceKind = TraceSourceConfigView['kind']
export type TraceSourceConfig = TraceSourceConfigView
export type TraceSourcesResponse = TraceSourceRoster

export type __traceSourceDriftGuard = [_configFwd, _configBack, _rosterFwd, _rosterBack]
