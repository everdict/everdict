// Which control-plane processes are alive (docs/architecture/multi-replica.md).
//
// Boot recovery's whole question is "did the process that was driving this record die?". Ownership is stamped
// on the record; liveness is this registry: every replica writes a heartbeat, and a replica that stopped
// writing one is gone as far as anyone else can tell. Deliberately thin — a control plane has a handful of
// replicas, so the caller reads the whole live set once rather than asking per record.
export interface ReplicaRegistry {
  // Announce that this process is still running. Called on a timer by every replica, leader or not.
  beat(): Promise<void>;
  // The replicas whose heartbeat is recent enough to count as alive. Includes this process.
  liveReplicas(): Promise<string[]>;
  // Stop counting as alive (a clean shutdown), so the successor reclaims this replica's interrupted work
  // immediately instead of waiting out the staleness window. Best-effort — a crash simply skips it.
  leave(): Promise<void>;
}

// The single-process shape (no Postgres): there are no peers to be alive, so nothing a record could belong to
// is ever "still being driven by someone else" — recovery reclaims exactly what it always did.
export const soloReplicas: ReplicaRegistry = {
  async beat() {},
  async liveReplicas() {
    return [];
  },
  async leave() {},
};
