import { z } from "zod";

// GET /runtimes/:id/versions/:version/inspect 200 — a live read model of a registered nomad/k8s runtime (cluster).
// Unlike probe (reachability/auth only) this also enumerates the cluster's composition, capacity, live everdict
// workload, and any shared stores. Read-only introspection — it runs no job and mutates nothing. The backend
// produces this (Inspectable.inspect in @everdict/backends); this schema is the SSOT the interface's type derives from.
// Degrade like probe: a partial-cluster failure never throws — the unreachable/failed sub-read lands in `warnings`
// and the rest still renders (a config error at build time is still a hard 4xx, surfaced by the service).

// One cluster node (Nomad client / K8s node). Resource fields are optional — cheap list endpoints omit them.
export const InspectNodeSchema = z.object({
  name: z.string(),
  status: z.string().describe("Readiness as the orchestrator reports it (e.g. 'ready'/'down', 'Ready'/'NotReady')"),
  ready: z.boolean().describe("Normalized readiness so the UI can count healthy nodes without parsing status text"),
  datacenter: z.string().optional().describe("Nomad datacenter (k8s has none)"),
  dockerHealthy: z.boolean().optional().describe("Nomad: the docker task-driver's health on this node"),
  // Whether the node accepts new placements (Nomad eligibility / k8s !unschedulable). false = cordoned. Drives the
  // cordon/uncordon toggle. Absent when the list endpoint doesn't carry it.
  schedulable: z.boolean().optional(),
  // Total schedulable resources in the runtime's native unit (Nomad: CPU MHz; K8s: CPU millicores) / memory in MiB.
  // The web draws a per-node usage bar (allocated = the sum of the workloads placed on this node / this total).
  cpuTotal: z.number().optional(),
  memoryMbTotal: z.number().optional(),
});
export type InspectNode = z.infer<typeof InspectNodeSchema>;

// One live everdict workload unit (a running/pending alloc or pod the control plane placed on this cluster).
export const InspectWorkloadSchema = z.object({
  id: z.string(),
  name: z.string().describe("The orchestrator job/alloc name (e.g. everdict-<caseId>-<suffix>)"),
  status: z.string(),
  ageSeconds: z
    .number()
    .optional()
    .describe("Wall-clock since the unit was created — a long-running unit is an idle-reclaim candidate"),
  node: z.string().optional().describe("The node it is placed on"),
  role: z
    .enum(["eval", "store", "other"])
    .describe("Classified from the name: an everdict eval job, a shared topology store, or other"),
  // This unit's resource ask, same units as InspectNode (Nomad CPU MHz / K8s CPU millicores; memory MiB). Lets the
  // web size each unit's block inside its node and sum the per-node allocation. Absent when the source omits it.
  cpu: z.number().optional(),
  memoryMb: z.number().optional(),
});
export type InspectWorkload = z.infer<typeof InspectWorkloadSchema>;

// A shared topology store standing on this cluster (pool tier: everdict-shared-<store>). Address is the connection
// endpoint where cheaply known (k8s Service DNS is deterministic; Nomad's is a dynamic alloc port, so it is omitted).
export const InspectStoreSchema = z.object({
  name: z.string(),
  status: z.string().optional(),
  address: z.string().optional().describe("host:port connection endpoint, when cheaply resolvable (k8s Service DNS)"),
});
export type InspectStore = z.infer<typeof InspectStoreSchema>;

export const InspectRuntimeResultSchema = z.object({
  kind: z.string().describe("Runtime kind that was inspected"),
  reachable: z.boolean().describe("Reached the cluster API and (if credentials exist) authenticated"),
  detail: z.string().describe("Human-readable summary — identifying info on success, the reason on failure"),
  reason: z
    .enum(["auth", "unreachable", "error"])
    .optional()
    .describe("Structured failure class — absent when reachable"),
  // The sections below are present only when reachable; each is independently best-effort (a failed sub-read
  // is recorded in `warnings` and its section is simply omitted).
  cluster: z
    .object({
      name: z.string().optional(),
      version: z.string().optional(),
      datacenters: z.array(z.string()).optional(),
      namespace: z.string().optional().describe("The runtime's configured namespace, if any"),
    })
    .optional(),
  nodes: z
    .object({
      total: z.number(),
      ready: z.number(),
      items: z.array(InspectNodeSchema),
    })
    .optional(),
  capacity: z
    .object({
      total: z.number().describe("Concurrent eval-job slots the control plane may place here"),
      used: z.number().describe("In-flight everdict jobs observed on the cluster"),
      free: z.number().describe("max(0, total - used)"),
    })
    .optional(),
  workload: z.array(InspectWorkloadSchema).optional(),
  stores: z.array(InspectStoreSchema).optional(),
  // Non-fatal notes: which sub-reads degraded (e.g. "node listing failed"), so partial data reads honestly.
  warnings: z.array(z.string()).default([]),
});
export type InspectRuntimeResult = z.infer<typeof InspectRuntimeResultSchema>;
