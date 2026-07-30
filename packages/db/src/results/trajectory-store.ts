import type { TrajectoryMeta, TrajectoryStore } from "@everdict/application-control";
import { type TraceEvent, TraceEventSchema } from "@everdict/contracts";
import { z } from "zod";
import type { SqlClient } from "../client.js";

const EventsSchema = z.array(TraceEventSchema);

export class InMemoryTrajectoryStore implements TrajectoryStore {
  private readonly rows = new Map<string, { meta: TrajectoryMeta; events: TraceEvent[] }>();

  async seal(input: {
    runId: string;
    tenant: string;
    source: TrajectoryMeta["source"];
    events: TraceEvent[];
  }): Promise<TrajectoryMeta> {
    const existing = this.rows.get(input.runId);
    if (existing) return existing.meta; // first seal wins — evidence is never rewritten
    const meta: TrajectoryMeta = {
      runId: input.runId,
      tenant: input.tenant,
      source: input.source,
      eventCount: input.events.length,
      sealedAt: new Date().toISOString(),
    };
    this.rows.set(input.runId, { meta, events: input.events });
    return meta;
  }

  async get(tenant: string, runId: string): Promise<{ meta: TrajectoryMeta; events: TraceEvent[] } | undefined> {
    const row = this.rows.get(runId);
    return row && row.meta.tenant === tenant ? row : undefined;
  }
}

// Postgres-backed trajectory store (mig 0098) — ON CONFLICT DO NOTHING makes the seal first-write-wins.
export class PgTrajectoryStore implements TrajectoryStore {
  constructor(private readonly client: SqlClient) {}

  async seal(input: {
    runId: string;
    tenant: string;
    source: TrajectoryMeta["source"];
    events: TraceEvent[];
  }): Promise<TrajectoryMeta> {
    const sealedAt = new Date().toISOString();
    await this.client.query(
      `INSERT INTO everdict_trajectories (run_id, tenant, source, event_count, body, sealed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id) DO NOTHING`,
      [input.runId, input.tenant, input.source, input.events.length, JSON.stringify(input.events), sealedAt],
    );
    // Read back — a lost race returns the FIRST seal's meta (never pretend the late write took).
    const sealed = await this.get(input.tenant, input.runId);
    if (sealed) return sealed.meta;
    return {
      runId: input.runId,
      tenant: input.tenant,
      source: input.source,
      eventCount: input.events.length,
      sealedAt,
    };
  }

  async get(tenant: string, runId: string): Promise<{ meta: TrajectoryMeta; events: TraceEvent[] } | undefined> {
    const res = await this.client.query<{
      run_id: string;
      tenant: string;
      source: string;
      event_count: number;
      body: unknown;
      sealed_at: string | Date;
    }>("SELECT run_id, tenant, source, event_count, body, sealed_at FROM everdict_trajectories WHERE run_id = $1", [
      runId,
    ]);
    const row = res.rows[0];
    if (!row || row.tenant !== tenant) return undefined;
    return {
      meta: {
        runId: row.run_id,
        tenant: row.tenant,
        source: row.source as TrajectoryMeta["source"],
        eventCount: Number(row.event_count),
        sealedAt: typeof row.sealed_at === "string" ? row.sealed_at : row.sealed_at.toISOString(),
      },
      events: EventsSchema.parse(row.body),
    };
  }
}
