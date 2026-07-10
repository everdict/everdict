import type { EnvSnapshot, ServiceHarnessSpec, TrustZone } from "@everdict/contracts";

// warm topology handle: service name → base URL (front-door etc.).
export interface TopologyHandle {
  endpoints: Record<string, string>;
}

// per-case target-env handle — the "named coordinates" (wiring) the agent reaches + the observation surface.
// wiring is merged into the per-run wiring vocabulary → bodyTemplate references any coordinate the target declares via {{...}}.
// A CDP browser is the special case of a 1-element bag ({ target_cdp_url }). A session-style target contributes several coordinates at once
// (playwright_server_url/action_stream_url/session_id…). Design: docs/architecture/target-acquisition-generalization.md.
export interface TargetEnvHandle {
  wiring: Record<string, string>;
  snapshot(): Promise<EnvSnapshot>;
  dispose(): Promise<void>;
}

// Owns only orchestrator-specific topology deploy/discovery. This is where the Nomad/K8s implementations diverge.
// When a trustZone is given, the warm pool is separated per tenant (zone) and namespace/isolation is applied
// — an eval runs arbitrary code, so warm topologies must never be shared across tenants.
export interface TopologyRuntime {
  readonly id: string;
  ensureTopology(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<TopologyHandle>; // warm (per-zone)
  provisionBrowserEnv(spec: ServiceHarnessSpec, runId: string, zone?: TrustZone): Promise<TargetEnvHandle>; // per-case
  // Live-screen (observability ⑦): the CDP HTTP base of a run's already-provisioned browser (rediscovered by
  // runId — no new provisioning), or undefined if there is none running. Optional: only runtimes with a
  // per-case browser implement it. best-effort.
  browserCdpBase?(runId: string, zone?: TrustZone): Promise<string | undefined>;
}
