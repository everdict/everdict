import type {
  InspectRuntimeResult,
  RuntimeListEntry,
  RuntimeControlCommand as WireRuntimeControlCommand,
  RuntimeControlResult as WireRuntimeControlResult,
} from '@everdict/contracts/wire'
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

// GET /runtimes/:id/versions/:version/inspect — the live cluster view (read-only). Identical-shape to the wire
// DTO (not a discriminated union), so the boundary schema is anchored bidirectionally like the summary.
const inspectNodeSchema = z.object({
  name: z.string(),
  status: z.string(),
  ready: z.boolean(),
  datacenter: z.string().optional(),
  dockerHealthy: z.boolean().optional(),
  schedulable: z.boolean().optional(),
})
const inspectWorkloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  ageSeconds: z.number().optional(),
  node: z.string().optional(),
  role: z.enum(['eval', 'store', 'other']),
})
const inspectStoreSchema = z.object({
  name: z.string(),
  status: z.string().optional(),
  address: z.string().optional(),
})
export const runtimeInspectionSchema = z.object({
  kind: z.string(),
  reachable: z.boolean(),
  detail: z.string(),
  reason: z.enum(['auth', 'unreachable', 'error']).optional(),
  cluster: z
    .object({
      name: z.string().optional(),
      version: z.string().optional(),
      datacenters: z.array(z.string()).optional(),
      namespace: z.string().optional(),
    })
    .optional(),
  nodes: z
    .object({ total: z.number(), ready: z.number(), items: z.array(inspectNodeSchema) })
    .optional(),
  capacity: z.object({ total: z.number(), used: z.number(), free: z.number() }).optional(),
  workload: z.array(inspectWorkloadSchema).optional(),
  stores: z.array(inspectStoreSchema).optional(),
  warnings: z.array(z.string()).default([]),
})

// POST …/control result — a destructive-action outcome (ok + optional stopped/purged count). Identical-shape to the wire DTO.
export const runtimeControlResultSchema = z.object({
  action: z.string(),
  ok: z.boolean(),
  stopped: z.number().optional(),
  purged: z.number().optional(),
})

// Drift guard — RuntimeSummary + RuntimeInspection are identical-shape to their wire DTOs, so each guard is
// bidirectional: a renamed/added field on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebRuntimeSummary = z.infer<typeof runtimeSummarySchema>
type _summaryFwd = AssertAssignable<WebRuntimeSummary, RuntimeListEntry>
type _summaryBack = AssertAssignable<RuntimeListEntry, WebRuntimeSummary>
type WebRuntimeInspection = z.infer<typeof runtimeInspectionSchema>
type _inspectFwd = AssertAssignable<WebRuntimeInspection, InspectRuntimeResult>
type _inspectBack = AssertAssignable<InspectRuntimeResult, WebRuntimeInspection>
type WebRuntimeControlResult = z.infer<typeof runtimeControlResultSchema>
type _controlFwd = AssertAssignable<WebRuntimeControlResult, WireRuntimeControlResult>
type _controlBack = AssertAssignable<WireRuntimeControlResult, WebRuntimeControlResult>

// Exported name aliases the contract type (consumers untouched: same RuntimeSummary identifier).
export type RuntimeSummary = RuntimeListEntry
export type RuntimeInspection = InspectRuntimeResult
export type RuntimeControlResult = WireRuntimeControlResult
// The command the UI builds and sends (discriminated action) — type-only from the contract.
export type RuntimeControlCommand = WireRuntimeControlCommand

export type __runtimeDriftGuard = [
  _summaryFwd,
  _summaryBack,
  _inspectFwd,
  _inspectBack,
  _controlFwd,
  _controlBack,
]
