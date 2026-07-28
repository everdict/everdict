import type { EnvSnapshot, ServiceHarnessSpec, StoreReadQuery, TrustZone } from "@everdict/contracts";
import type { StoreSeedPlan } from "./store-seed.js";

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
  // Host/control-plane-reachable CDP HTTP base of THIS per-case browser (e.g. http://127.0.0.1:<hostPort>), when the
  // target is a CDP browser. Distinct from wiring.target_cdp_url, which is the AGENT-facing internal alias (unreachable
  // from the recorder's side). The environment recorder taps this to stream network/console/nav (+ screencast frames)
  // for replay (docs/architecture/replay.md D5). Absent for a non-browser / injection-free target.
  cdpBase?: string;
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
  // Seed a case's world-state fixtures into their per-case isolation slices in the warm topology's stores (P2). The
  // runtime owns store-container reach + exec, so it applies the resolved plans (buildSeedExec → psql/…) for this runId.
  // Optional: only runtimes that can exec into their stores implement it — a case with fixtures on a runtime without it
  // fails the run (the required world-state can't be established). docs/architecture/dependency-store-roles.md P2.
  seedFixtures?(spec: ServiceHarnessSpec, runId: string, plans: StoreSeedPlan[], zone?: TrustZone): Promise<void>;
  // Read a data store's post-run isolation slice for store-state grading (P2) — the co-located read the grader can't do
  // itself (an internal store URL is unreachable from a remote grader). Resolves (store, role) → slice and runs the
  // query there, returning stdout. Optional: only store-exec-capable runtimes implement it.
  readStoreState?(spec: ServiceHarnessSpec, runId: string, query: StoreReadQuery, zone?: TrustZone): Promise<string>;
  // Tear down one warm topology (cluster job/namespace/containers + the warm entry). Formalized on the port (A9) —
  // the impls existed but had NO caller, so nothing ever reclaimed a warm topology.
  teardown?(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<void>;
  // Reclaim warm topologies idle past idleMs (best-effort per entry; never throws). The runtimes self-schedule this
  // on an unref'd interval, so superseded versions' warm jobs stop exhausting the cluster even with no new dispatch.
  // Returns the reclaimed warm keys (observability/tests).
  sweepIdle?(idleMs: number): Promise<string[]>;
}

// Warm-topology reclamation defaults (A9). Browser sessions always swept on a 60s timer; warm topologies never did —
// version iteration then piled superseded warm jobs up until the cluster ran out of capacity. A warm topology idle
// for 30 minutes is torn down; the next ensure simply redeploys (the whole point of the warm pool is to amortize
// ACTIVE traffic, not to pin dead versions forever).
export const DEFAULT_WARM_IDLE_TTL_MS = 30 * 60_000;
export const DEFAULT_WARM_SWEEP_INTERVAL_MS = 60_000;
