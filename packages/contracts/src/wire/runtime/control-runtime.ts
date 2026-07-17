import { z } from "zod";

// POST /runtimes/:id/versions/:version/control — a DESTRUCTIVE live-cluster control command for a registered
// nomad/k8s runtime (gated runtimes:control, admin-only). Each action is best-effort/idempotent on the backend;
// the caller re-inspects after. Command + result are the SSOT here — apps/api validates with the command schema,
// the web anchors its local boundary schema to these types.
export const RuntimeControlCommandSchema = z.discriminatedUnion("action", [
  // Force-stop one live unit by its InspectWorkload.name — an everdict unit (aborts that one eval — a blunt infra
  // reclaim) OR an external service (K8s: deletes the pod's owning controller; Nomad: deregisters the job).
  // namespace (from InspectWorkload.namespace) disambiguates an external unit; omitted = everdict-unit lookup.
  z.object({ action: z.literal("stopWorkload"), name: z.string().min(1), namespace: z.string().optional() }),
  // Stop every non-store everdict eval unit running longer than the threshold (bulk idle reclaim; external units untouched).
  z.object({ action: z.literal("reclaimIdle"), olderThanSeconds: z.number().int().positive() }),
  // GC dead/completed everdict jobs (reclaim slots/disk). No live impact.
  z.object({ action: z.literal("purgeTerminal") }),
  // Cordon (schedulable:false) / uncordon (true) a node by name — reversible maintenance, no eviction.
  z.object({ action: z.literal("cordonNode"), node: z.string().min(1), schedulable: z.boolean() }),
  // Change a unit's resource ask, in the runtime's NATIVE units (cpu: Nomad MHz / K8s millicores; memory MiB) — at
  // least one of cpu/memoryMb (enforced by the controller, not the schema: zod v3 discriminated-union members can't
  // carry refinements). Nomad: rewrites a single-task job's Resources and resubmits (the alloc is replaced); K8s:
  // patches the pod's owning controller template (Deployment/StatefulSet/DaemonSet — a rolling replace). Unsupported
  // targets (multi-task/multi-container, K8s Job, bare pod) are a clear 400, never a silent no-op.
  z.object({
    action: z.literal("resizeWorkload"),
    name: z.string().min(1),
    namespace: z.string().optional(),
    cpu: z.number().int().positive().optional(),
    memoryMb: z.number().int().positive().optional(),
  }),
]);
export type RuntimeControlCommand = z.infer<typeof RuntimeControlCommandSchema>;

export const RuntimeControlResultSchema = z.object({
  action: z.string(),
  ok: z.boolean(),
  stopped: z.number().optional().describe("reclaimIdle — how many units were stopped"),
  purged: z.number().optional().describe("purgeTerminal — how many jobs were reaped"),
  detail: z.string().optional().describe("resizeWorkload — what was resized to what (human-readable)"),
});
export type RuntimeControlResult = z.infer<typeof RuntimeControlResultSchema>;
