import { z } from "zod";

// GET /runs/:id/topology 200 — the live health roster of a service-topology harness's deployed services (the
// warm topology the run drives). Answers "the case was placed, but is the SERVICE stack actually up and healthy"
// — per-service state, restart churn, OOM kills, and the last notable orchestrator event. Produced by the
// TopologyRuntime behind the run's runtime lane (TopologyInspectable in @everdict/backends); this schema is the
// SSOT the interfaces' types derive from. Best-effort like every observability read.

export const TopologyServiceStatusSchema = z.object({
  name: z.string().describe("The service name as declared in the harness spec (or a dependency store's name)"),
  status: z.string().describe("Orchestrator-reported state (e.g. 'running', 'pending', 'dead', 'absent')"),
  ready: z.boolean().optional().describe("Normalized 'is it up' so the UI can count healthy services"),
  restarts: z.number().optional().describe("Restart count — churn here is the OOM-loop / crash-loop signal"),
  oom: z.boolean().optional().describe("The service's events indicate an OOM kill (exit 137)"),
  node: z.string().optional().describe("The cluster node the service is placed on, when known"),
  lastEvent: z.string().optional().describe("The most recent notable orchestrator event message"),
});
export type TopologyServiceStatus = z.infer<typeof TopologyServiceStatusSchema>;

export const TopologyStatusSchema = z.object({
  deployed: z.boolean().describe("Whether the warm topology is currently standing on the cluster"),
  runtime: z.string().optional().describe("The topology runtime kind that answered (nomad | k8s | docker)"),
  namespace: z.string().optional().describe("Orchestrator namespace (tenant trust zone), when applicable"),
  services: z.array(TopologyServiceStatusSchema).default([]),
});
export type TopologyStatus = z.infer<typeof TopologyStatusSchema>;

// GET /runs/:id/topology — the route envelope. found=false = the run's harness is not a service topology, the
// lane has no topology runtime, or the read degraded (never an error).
export const RunTopologyResponseSchema = z.object({
  status: z.string(),
  found: z.boolean(),
  topology: TopologyStatusSchema.nullable(),
});
export type RunTopologyResponse = z.infer<typeof RunTopologyResponseSchema>;

// GET /runs/:id/topology/services/:service/logs — one deployed service's current log tail.
export const ServiceLogsResponseSchema = z.object({
  found: z.boolean().describe("false = no live service unit to read (not deployed / unsupported runtime)"),
  text: z.string().describe("Current log tail (empty string when found=false)"),
});
export type ServiceLogsResponse = z.infer<typeof ServiceLogsResponseSchema>;
