import type { RuntimeListEntry } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED list type is anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// GET /runtimes response: the runtime list a tenant sees (owned + _shared).
export const runtimeSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
  // version → free-form labels (only versions that have tags) — mutable meta outside the spec (for telling versions apart).
  versionTags: z.record(z.string(), z.array(z.string())).optional(),
  // Latest version's declared capabilities (docker/topology/…) — surfaced so the submit-time picker can preview whether
  // the runtime can run the chosen harness. Absent = the runtime declares none (treated as unchecked, no badge).
  capabilities: z.array(z.string()).optional(),
})
export const runtimesSchema = z.array(runtimeSummarySchema)

// full RuntimeSpec (local | nomad | k8s) — DELIBERATELY LOOSE flat display mirror (the rest passthrough).
// This stays LOCAL and is NOT anchored: the contract RuntimeSpec is a DISCRIMINATED UNION (nomad requires
// addr/image, k8s requires image, plus a `capabilities` field and a required `tags`), whereas the web flattens
// every kind-specific field to optional so the detail view can read any field defensively. The two shapes
// genuinely diverge (flat-optional vs kind-narrowed union), so no assignability guard can bind them — the web
// only displays fields, it never reconstructs a spec, so the loose local type is correct here.
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
    server: z.string().optional(),
    kubeconfigSecret: z.string().optional(),
    // common (nomad/k8s)
    image: z.string().optional(),
    namespace: z.string().optional(),
    tags: z.array(z.string()).optional(),
    // SecretStore key NAME (never the value) — safe to display; the control plane resolves the value at dispatch.
    authSecret: z.string().optional(),
    // Auto-labeled capabilities the runtime advertises (docker/sandbox/topology). Read-only.
    capabilities: z.array(z.string()).optional(),
    // topology config — kept loose (passthrough) so the full source (authSecret/correlate/scope) round-trips on edit/probe.
    traceSource: z
      .object({ kind: z.string(), endpoint: z.string().optional() })
      .passthrough()
      .optional(),
    browserImage: z.string().optional(),
    // admission envelope — how much the control plane may pack onto this runtime concurrently
    maxConcurrent: z.number().optional(),
    memoryBudgetMb: z.number().optional(),
    cpuBudget: z.number().optional(),
  })
  .passthrough()
export type RuntimeSpec = z.infer<typeof runtimeSpecSchema>

// Drift guard — RuntimeSummary is identical-shape to the wire list entry (id/owner/versions/versionTags), so
// the guard is bidirectional: a renamed/added field on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebRuntimeSummary = z.infer<typeof runtimeSummarySchema>
type _summaryFwd = AssertAssignable<WebRuntimeSummary, RuntimeListEntry>
type _summaryBack = AssertAssignable<RuntimeListEntry, WebRuntimeSummary>

// Exported name aliases the contract type (consumers untouched: same RuntimeSummary identifier).
export type RuntimeSummary = RuntimeListEntry

export type __runtimeDriftGuard = [_summaryFwd, _summaryBack]
