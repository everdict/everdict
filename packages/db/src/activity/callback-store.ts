import type { SqlClient } from "../client.js";

// Front-door callback store — the persistence behind the multi-replica callback rendezvous
// (docs/architecture/completion-stream-callback.md). With several control planes, the agent's terminal
// POST /frontdoor-callback/:runId may land on a replica that isn't driving the run: deliver() writes the body
// here, and the driving replica's wait loop CLAIMS it (atomically — exactly one waiter consumes each body).
export interface CallbackStore {
  deliver(runId: string, body: unknown): Promise<void>;
  // Claim the oldest unconsumed body for the run (atomic across replicas). undefined = nothing yet.
  claim(runId: string): Promise<{ body: unknown } | undefined>;
}

export class InMemoryCallbackStore implements CallbackStore {
  private readonly pending = new Map<string, unknown[]>();

  async deliver(runId: string, body: unknown): Promise<void> {
    const queue = this.pending.get(runId) ?? [];
    queue.push(body);
    this.pending.set(runId, queue);
  }

  async claim(runId: string): Promise<{ body: unknown } | undefined> {
    const queue = this.pending.get(runId);
    if (!queue || queue.length === 0) return undefined;
    const body = queue.shift();
    if (queue.length === 0) this.pending.delete(runId);
    return { body };
  }
}

// Postgres store (migration 0050). claim = FOR UPDATE SKIP LOCKED single-row consume, so two replicas polling
// the same run never double-consume. Consumed/stale rows are swept opportunistically on deliver (callbacks are
// short-lived plumbing, not history).
export class PgCallbackStore implements CallbackStore {
  constructor(private readonly client: SqlClient) {}

  async deliver(runId: string, body: unknown): Promise<void> {
    await this.client.query("INSERT INTO everdict_frontdoor_callbacks (run_id, body) VALUES ($1, $2)", [
      runId,
      JSON.stringify(body),
    ]);
    // Opportunistic sweep — anything consumed or older than an hour is dead plumbing.
    await this.client.query(
      "DELETE FROM everdict_frontdoor_callbacks WHERE consumed OR created_at < now() - interval '1 hour'",
      [],
    );
  }

  async claim(runId: string): Promise<{ body: unknown } | undefined> {
    const res = await this.client.query<{ body: unknown }>(
      `UPDATE everdict_frontdoor_callbacks SET consumed = true
       WHERE id = (
         SELECT id FROM everdict_frontdoor_callbacks
         WHERE run_id = $1 AND NOT consumed
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING body`,
      [runId],
    );
    const row = res.rows[0];
    return row ? { body: row.body } : undefined;
  }
}
