import type { TraceSinkConfigView, TraceSinkRoster } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Client mirror of the control-plane /workspace/trace-sinks response — workspace trace sinks (observability-platform export, multiple).
// No secrets: authSecretName is a SecretStore name reference, not a value. Auth values never reach the browser.
export const traceSinkKindSchema = z.enum(['mlflow', 'langfuse', 'langsmith', 'phoenix'])

export const traceSinkConfigSchema = z.object({
  name: z.string(), // sink identifier — the key for upsert/delete/per-harness selection (assignment)
  kind: traceSinkKindSchema,
  endpoint: z.string(),
  authSecretName: z.string().optional(),
  project: z.string().optional(), // per-kind coordinate: mlflow experiment_id · langsmith project · phoenix project · langfuse projectId
  webUrl: z.string().optional(),
})

// GET /workspace/trace-sinks → { sinks, assignments }; assignments = harness id → sink name (per-harness selection).
export const traceSinksResponseSchema = z.object({
  sinks: z.array(traceSinkConfigSchema),
  assignments: z.record(z.string(), z.string()),
})

// Drift guards — both are identical-shape (config = every wire field; roster = sinks + assignments), so the
// guards are bidirectional: a renamed/added field or a widened kind on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebTraceSinkConfig = z.infer<typeof traceSinkConfigSchema>
type WebTraceSinksResponse = z.infer<typeof traceSinksResponseSchema>
type _configFwd = AssertAssignable<WebTraceSinkConfig, TraceSinkConfigView>
type _configBack = AssertAssignable<TraceSinkConfigView, WebTraceSinkConfig>
type _rosterFwd = AssertAssignable<WebTraceSinksResponse, TraceSinkRoster>
type _rosterBack = AssertAssignable<TraceSinkRoster, WebTraceSinksResponse>

// Exported names alias the contract types (consumers untouched: same identifiers).
export type TraceSinkKind = TraceSinkConfigView['kind']
export type TraceSinkConfig = TraceSinkConfigView
export type TraceSinksResponse = TraceSinkRoster

export type __traceSinkDriftGuard = [_configFwd, _configBack, _rosterFwd, _rosterBack]
