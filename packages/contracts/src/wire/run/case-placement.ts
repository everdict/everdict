import { z } from "zod";

// GET /runs/:id/placement 200 — where a run's case job actually stands INSIDE its runtime (the Nomad/K8s
// cluster): placed or not, on which node, and why not. This is the case-scoped sibling of the runtime-scoped
// InspectRuntimeResult — inspect() answers "what is the cluster doing", this answers "what is the cluster doing
// WITH MY CASE". The backend produces it (CaseInspectable.inspectCase in @everdict/backends); this schema is the
// SSOT the interface's type derives from. Best-effort like every observability read: a backend that can't tell
// returns undefined (served as found=false), never an error.

// One orchestrator-level event on the case's unit (Nomad alloc task event / K8s object event) — the raw WHY feed
// (image pull denied, OOM kill, restart churn, scheduling failures) that previously only surfaced inside thrown
// error messages after the run had already failed.
export const PlacementEventSchema = z.object({
  type: z.string().optional().describe("Orchestrator event type/reason (e.g. 'Driver', 'FailedScheduling', 'Pulling')"),
  message: z.string().describe("The human-readable cause as the orchestrator reports it"),
  at: z.string().optional().describe("ISO timestamp, when the source carries one"),
});
export type PlacementEvent = z.infer<typeof PlacementEventSchema>;

export const CasePlacementSchema = z.object({
  // The placement verdict, normalized across orchestrators:
  //   queued   — the job is submitted and the scheduler has not placed a unit yet (normal warm-up)
  //   blocked  — the scheduler CANNOT place it right now (capacity/eligibility) — blockedReason carries the verdict
  //   starting — a unit exists but is not running yet (image pull, task setup)
  //   running  — the unit is executing on a node
  //   dead     — the unit reached a terminal state (complete/failed/lost) — events explain why
  phase: z.enum(["queued", "blocked", "starting", "running", "dead"]),
  job: z.string().optional().describe("The orchestrator job id/name the case dispatched as"),
  unit: z.string().optional().describe("The placed unit's id — Nomad allocation id / K8s pod name"),
  node: z.string().optional().describe("The cluster node the unit is placed on"),
  namespace: z.string().optional().describe("Orchestrator namespace (tenant trust zone)"),
  // The scheduler's "cannot place this anywhere right now" verdict, human-readable: Nomad's blocked-evaluation
  // exhausted dimensions ("cpu exhausted on 2 node(s)") / K8s' FailedScheduling message ("0/3 nodes are
  // available: insufficient memory"). Present only in phase "blocked".
  blockedReason: z.string().optional(),
  restarts: z.number().optional().describe("Task/container restart count observed on the unit"),
  oom: z.boolean().optional().describe("The unit's events indicate an OOM kill (exit 137)"),
  // Live resource ask of the placed unit (best-effort): Nomad AllocatedResources (CPU MHz) / K8s pod requests
  // (millicores), memory in MiB — the "how much did this case actually reserve" half of a capacity diagnosis.
  cpu: z.number().optional(),
  memoryMb: z.number().optional(),
  ageSeconds: z.number().optional().describe("Wall-clock since the unit was created, when the source carries it"),
  events: z.array(PlacementEventSchema).default([]),
});
export type CasePlacement = z.infer<typeof CasePlacementSchema>;

// GET /runs/:id/placement — the route envelope: the run's status (so pollers can stop at terminal) + the
// placement read. found=false = nothing to describe (queued before dispatch, job GC'd, or no backend support).
export const RunPlacementResponseSchema = z.object({
  status: z.string(),
  found: z.boolean().describe("false = no orchestrator job to describe (pre-dispatch / GC'd / unsupported backend)"),
  placement: CasePlacementSchema.nullable(),
});
export type RunPlacementResponse = z.infer<typeof RunPlacementResponseSchema>;
