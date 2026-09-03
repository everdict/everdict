import type { EnvSnapshot, ServiceHarnessSpec, StoreReadQuery, TrustZone } from "@everdict/contracts";
import type { TopologyStatus } from "@everdict/contracts/wire";
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
  // Host/control-plane-reachable CDP HTTP base of THIS case's browser (e.g. http://127.0.0.1:<hostPort>), when the
  // target is a CDP browser. Distinct from wiring.target_cdp_url, which is the AGENT-facing internal alias (unreachable
  // from the recorder's side). The environment recorder taps this to stream network/console/nav (+ screencast frames)
  // for replay (docs/architecture/replay.md D5), and the live screen captures from it. A provisioned browser always
  // has one; a session-acquired browser has one only when the session API declares where to read it
  // (`acquire.cdpBase`) — that declaration is the difference between a watchable session and an opaque one.
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
  // Name what's wrong with the warm topology's SERVICES (A6) — OOM kills (exit 137), restart churn — so a drive
  // failure/timeout explains itself. Downstream lost 30 minutes to "the agent did not finish within the budget"
  // while a service was OOM-looping (exit 137) the whole time; nothing surfaced the restarts anywhere. Optional +
  // best-effort: undefined = nothing notable / not inspectable.
  diagnose?(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<string | undefined>;
  // The STRUCTURED sibling of diagnose — the live per-service health roster of the warm topology (state, restart
  // churn, OOM kills, last notable event), readable WHILE a run drives it instead of only inside a timeout error
  // message. undefined = no live topology / the runtime can't tell. Optional + best-effort, never throws.
  describeTopology?(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<TopologyStatus | undefined>;
  // One deployed service's current log tail (the service-level twin of the case job's Backend.logs) — the read
  // that answers "the stack is up but the case fails: what is the SERVICE saying". undefined = no live unit for
  // that service. Optional + best-effort, never throws.
  serviceLogs?(spec: ServiceHarnessSpec, service: string, zone?: TrustZone): Promise<string | undefined>;
  // Reclaim warm topologies idle past idleMs (best-effort per entry; never throws). The runtimes self-schedule this
  // on an unref'd interval, so superseded versions' warm jobs stop exhausting the cluster even with no new dispatch.
  // Returns the reclaimed warm keys (observability/tests).
  sweepIdle?(idleMs: number): Promise<string[]>;
  // Elastic session pools (the actuation half): the DESIRED replica count of ONE deployed service of the warm
  // topology, and the write that changes it. Optional: only runtimes that can address a single service's scale
  // implement them (K8s — one Deployment per service, the Service DNS spreads sessions across replicas). The
  // Nomad co-located topology deliberately does NOT: scaling its one group replicates the whole stack while
  // endpoint discovery stays pinned to one alloc, so the added capacity would never be reached — that needs an
  // LB/mesh front first. serviceReplicas is best-effort (undefined = unreadable → the autoscaler skips a tick);
  // scaleService THROWS on failure — a scale that silently no-ops would read as "capacity added".
  serviceReplicas?(spec: ServiceHarnessSpec, service: string, zone?: TrustZone): Promise<number | undefined>;
  scaleService?(spec: ServiceHarnessSpec, service: string, replicas: number, zone?: TrustZone): Promise<void>;
}

// Warm-topology reclamation defaults (A9). Browser sessions always swept on a 60s timer; warm topologies never did —
// version iteration then piled superseded warm jobs up until the cluster ran out of capacity. A warm topology idle
// for 30 minutes is torn down; the next ensure simply redeploys (the whole point of the warm pool is to amortize
// ACTIVE traffic, not to pin dead versions forever).
export const DEFAULT_WARM_IDLE_TTL_MS = 30 * 60_000;
export const DEFAULT_WARM_SWEEP_INTERVAL_MS = 60_000;

// ── A WORLD IS NOT A WARM-POOL ENTRY (docs/architecture/world-and-engagement-model.md, 3.9) ──────────
//
// A topology deployed as a case's WORLD is owned by the created-world ledger: it records the intent before
// the world exists, holds the refcount that says how many cases are inside it, and tears it down only after a
// read-back says it is gone. The warm pool's idle sweeper answers the same question — when may this be
// reclaimed — from a different clock, and it would win: `lastUsedAt` is bumped by `ensureTopology`, a shared
// world is ensured ONCE, and the default idle TTL is thirty minutes. A batch longer than that would have its
// world reclaimed underneath live cases, and the scores would come back looking like ordinary failures.
//
// Two reclaimers for one object is the two-readers defect (rule `protocol` L3), so the sweeper defers: these
// two functions are the only place the name is minted and the only place it is recognised.
export function worldTopologyId(runId: string): string {
  return `everdict-world-${runId}`;
}

export function isWorldTopology(id: string): boolean {
  return id.startsWith("everdict-world-");
}
