import type { InspectWorkload } from "@everdict/contracts/wire";

// Shared runtime-inspection helpers used by both the Nomad and K8s backends, kept pure so they unit-test without a cluster.

// The pool-tier shared store naming convention (topology deploy: everdict-shared-<store>, k8s Service / Nomad task group).
// Kept in sync with packages/topology sharedStoreName(); a store on the cluster is discoverable by this prefix alone.
export const SHARED_STORE_PREFIX = "everdict-shared-";
// Every everdict-placed workload (eval jobs and shared stores) carries this prefix — the capacity probe already relies on it.
export const EVERDICT_PREFIX = "everdict-";
// Cap on the live-workload list so a busy cluster can't balloon the response; the overflow is surfaced as a warning.
export const WORKLOAD_CAP = 100;
// Cap on per-node detail reads (Nomad /v1/node/:id + allocations; K8s kubelet fs-stats summary) — bounds the extra
// calls per inspect poll on a big cluster. Nodes past the cap simply omit the detail fields.
export const NODE_DETAIL_CAP = 30;

// Classify a workload unit from its orchestrator name. A shared store (everdict-shared-*) is checked before the
// generic everdict-* eval prefix (the store prefix is a superset); anything else on the cluster is "other".
export function classifyWorkloadRole(name: string): InspectWorkload["role"] {
  if (name.startsWith(SHARED_STORE_PREFIX)) return "store";
  if (name.startsWith(EVERDICT_PREFIX)) return "eval";
  return "other";
}
