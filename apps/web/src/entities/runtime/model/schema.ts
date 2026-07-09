import { z } from 'zod'

// Client mirror of the control plane RuntimeSpec (execution infra). The web couples over HTTP only — no backend package dependency.
// GET /runtimes response: the runtime list a tenant sees (owned + _shared).
export const runtimeSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
  // version → free-form labels (only versions that have tags) — mutable meta outside the spec (for telling versions apart).
  versionTags: z.record(z.string(), z.array(z.string())).optional(),
})
export type RuntimeSummary = z.infer<typeof runtimeSummarySchema>
export const runtimesSchema = z.array(runtimeSummarySchema)

// full RuntimeSpec (local | nomad | k8s) — loose mirror for display (the rest passthrough).
export const runtimeSpecSchema = z
  .object({
    kind: z.enum(['local', 'nomad', 'k8s']),
    id: z.string(),
    version: z.string(),
    description: z.string().optional(),
    // nomad
    addr: z.string().optional(),
    datacenters: z.array(z.string()).optional(),
    runtime: z.string().optional(),
    // k8s
    context: z.string().optional(),
    runtimeClass: z.string().optional(),
    // common (nomad/k8s)
    image: z.string().optional(),
    namespace: z.string().optional(),
    tags: z.array(z.string()).optional(),
    // admission envelope — how much the control plane may pack onto this runtime concurrently
    maxConcurrent: z.number().optional(),
    memoryBudgetMb: z.number().optional(),
    cpuBudget: z.number().optional(),
  })
  .passthrough()
export type RuntimeSpec = z.infer<typeof runtimeSpecSchema>
