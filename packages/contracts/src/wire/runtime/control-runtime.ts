import { z } from "zod";

// POST /runtimes/:id/versions/:version/control — a DESTRUCTIVE live-cluster control command for a registered
// nomad/k8s runtime (gated runtimes:control, admin-only). Each action is best-effort/idempotent on the backend;
// the caller re-inspects after. Command + result are the SSOT here — apps/api validates with the command schema,
// the web anchors its local boundary schema to these types.
export const RuntimeControlCommandSchema = z.discriminatedUnion("action", [
  // Force-stop one live everdict unit by its InspectWorkload.name (aborts that one eval — a blunt infra reclaim).
  z.object({ action: z.literal("stopWorkload"), name: z.string().min(1) }),
  // Stop every non-store eval unit running longer than the threshold (bulk idle reclaim).
  z.object({ action: z.literal("reclaimIdle"), olderThanSeconds: z.number().int().positive() }),
  // GC dead/completed everdict jobs (reclaim slots/disk). No live impact.
  z.object({ action: z.literal("purgeTerminal") }),
  // Cordon (schedulable:false) / uncordon (true) a node by name — reversible maintenance, no eviction.
  z.object({ action: z.literal("cordonNode"), node: z.string().min(1), schedulable: z.boolean() }),
]);
export type RuntimeControlCommand = z.infer<typeof RuntimeControlCommandSchema>;

export const RuntimeControlResultSchema = z.object({
  action: z.string(),
  ok: z.boolean(),
  stopped: z.number().optional().describe("reclaimIdle — how many units were stopped"),
  purged: z.number().optional().describe("purgeTerminal — how many jobs were reaped"),
});
export type RuntimeControlResult = z.infer<typeof RuntimeControlResultSchema>;
