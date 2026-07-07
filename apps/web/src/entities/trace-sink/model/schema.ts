import { z } from 'zod'

// Client mirror of the control-plane /workspace/trace-sinks response — workspace trace sinks (observability-platform export, multiple).
// No secrets: authSecretName is a SecretStore name reference, not a value. Auth values never reach the browser.
export const traceSinkKindSchema = z.enum(['mlflow', 'langfuse', 'langsmith', 'phoenix'])
export type TraceSinkKind = z.infer<typeof traceSinkKindSchema>

export const traceSinkConfigSchema = z.object({
  name: z.string(), // sink identifier — the key for upsert/delete/per-harness selection (assignment)
  kind: traceSinkKindSchema,
  endpoint: z.string(),
  authSecretName: z.string().optional(),
  project: z.string().optional(), // per-kind coordinate: mlflow experiment_id · langsmith project · phoenix project · langfuse projectId
  webUrl: z.string().optional(),
})
export type TraceSinkConfig = z.infer<typeof traceSinkConfigSchema>

// GET /workspace/trace-sinks → { sinks, assignments }; assignments = harness id → sink name (per-harness selection).
export const traceSinksResponseSchema = z.object({
  sinks: z.array(traceSinkConfigSchema),
  assignments: z.record(z.string(), z.string()),
})
export type TraceSinksResponse = z.infer<typeof traceSinksResponseSchema>
