import type { ReplicaRegistry } from "@everdict/application-control";
import type { SqlClient } from "../client.js";

// Postgres-backed replica liveness (migration 0135, docs/architecture/multi-replica.md). One row per running
// control-plane process, refreshed on a timer; "alive" is judged by the DATABASE's clock against the row's own
// heartbeat, so a replica with a skewed clock cannot declare itself alive (or anyone else dead) by mistake.
export interface PgReplicaRegistryOptions {
  // This process's per-boot identity — the value the stores stamp onto the records it drives.
  replicaId: string;
  // How old a heartbeat may get before its replica counts as gone. The cost of setting it too LOW is the one
  // that matters: recovery would treat a replica that merely paused as dead and reclaim its live work, so it
  // must comfortably exceed the beat interval (default: three beats).
  staleMs?: number;
}

export class PgReplicaRegistry implements ReplicaRegistry {
  private readonly replicaId: string;
  private readonly staleMs: number;

  constructor(
    private readonly client: SqlClient,
    opts: PgReplicaRegistryOptions,
  ) {
    this.replicaId = opts.replicaId;
    this.staleMs = opts.staleMs ?? 30_000;
  }

  async beat(): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_control_plane_replicas (replica_id, started_at, heartbeat_at)
       VALUES ($1, now(), now())
       ON CONFLICT (replica_id) DO UPDATE SET heartbeat_at = now()`,
      [this.replicaId],
    );
  }

  async liveReplicas(): Promise<string[]> {
    const res = await this.client.query<{ replica_id: string }>(
      `SELECT replica_id FROM everdict_control_plane_replicas
       WHERE heartbeat_at > now() - make_interval(secs => $1)`,
      [this.staleMs / 1000],
    );
    return res.rows.map((r) => r.replica_id);
  }

  // Stop counting as alive — called on shutdown so a rolling restart's successor reclaims this replica's
  // orphaned work immediately instead of waiting out the staleness window.
  async leave(): Promise<void> {
    await this.client
      .query("DELETE FROM everdict_control_plane_replicas WHERE replica_id = $1", [this.replicaId])
      .catch(() => undefined);
  }
}
