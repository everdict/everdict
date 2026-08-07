import type { LeaderElector } from "@everdict/application-control";
import type { SqlClient } from "../client.js";

// Postgres-backed leader election (migration 0134, docs/architecture/multi-replica.md): one lease row per
// role, claimed and renewed by a single atomic upsert. Whoever the statement returns a row to is the leader
// until the lease expires; everybody else's upsert matches nothing and returns nothing.
//
// Every timestamp in the statement is the DATABASE's `now()` — a replica with a skewed clock can neither steal
// a live lease nor keep an expired one, because it never compares its own clock to anyone else's.
const CLAIM_SQL = `
  INSERT INTO everdict_control_plane_leases (role, holder, acquired_at, renewed_at, expires_at)
  VALUES ($1, $2, now(), now(), now() + make_interval(secs => $3))
  ON CONFLICT (role) DO UPDATE SET
    holder = excluded.holder,
    acquired_at = CASE
      WHEN everdict_control_plane_leases.holder = excluded.holder THEN everdict_control_plane_leases.acquired_at
      ELSE now()
    END,
    renewed_at = now(),
    expires_at = excluded.expires_at
  WHERE everdict_control_plane_leases.holder = excluded.holder
     OR everdict_control_plane_leases.expires_at < now()
  RETURNING holder`;

const RELEASE_SQL = "DELETE FROM everdict_control_plane_leases WHERE role = $1 AND holder = $2";

export interface PgLeaderElectorOptions {
  // What is being led. One lease per role, so a deployment could split loops across replicas later; today the
  // control plane elects one leader for all of its singleton loops.
  role: string;
  // WHO this process is — a per-boot identity. Two replicas must never share it (a restarted replica taking
  // its own old identity would inherit a lease it is no longer entitled to).
  holder: string;
  // How long a lease survives without renewal. The floor on failover: a crashed leader is replaceable only
  // after its lease expires, because nothing else can prove it is gone.
  ttlMs?: number;
  // How often to renew. Also the safety margin: this process stops believing it is leader ttlMs - renewMs
  // after its last SUCCESSFUL renewal, so a stalled event loop or a slow query can never let it act past the
  // moment somebody else may legitimately take over.
  renewMs?: number;
  now?: () => number;
  onChange?: (leader: boolean) => void;
}

export class PgLeaderElector implements LeaderElector {
  private readonly role: string;
  private readonly holder: string;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly now: () => number;
  private readonly onChange: ((leader: boolean) => void) | undefined;
  private heldUntil = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly client: SqlClient,
    opts: PgLeaderElectorOptions,
  ) {
    this.role = opts.role;
    this.holder = opts.holder;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.renewMs = opts.renewMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange;
  }

  isLeader(): boolean {
    return this.now() < this.heldUntil;
  }

  async start(): Promise<void> {
    await this.renew();
    this.timer ??= setInterval(() => void this.renew(), this.renewMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const wasLeader = this.isLeader();
    this.heldUntil = 0;
    if (!wasLeader) return;
    // Hand the lease back so the next replica takes over now instead of waiting out the TTL. Best-effort: a
    // shutdown that cannot reach the database still stops acting the moment heldUntil is cleared above.
    await this.client.query(RELEASE_SQL, [this.role, this.holder]).catch(() => undefined);
    this.onChange?.(false);
  }

  private async renew(): Promise<void> {
    const was = this.isLeader();
    try {
      const res = await this.client.query<{ holder: string }>(CLAIM_SQL, [this.role, this.holder, this.ttlMs / 1000]);
      // Won: believe it for one TTL minus the renewal interval, so two missed renewals stop us acting BEFORE
      // the row the others are watching can expire. Lost: somebody else holds a live lease — stand down now.
      this.heldUntil = res.rows.length > 0 ? this.now() + this.ttlMs - this.renewMs : 0;
    } catch {
      // A transient database failure is NOT proof we lost the lease — nobody else can take it before it
      // expires either. Keep what we already earned and let it decay: if the outage outlasts the margin,
      // isLeader() turns false on its own, which is the fail-closed answer.
    }
    const is = this.isLeader();
    if (is !== was) this.onChange?.(is);
  }
}
