import type { TrajectoryListResult, TrajectoryMeta, TrajectoryStore } from "@everdict/application-control";
import { type TraceEvent, TraceEventSchema } from "@everdict/contracts";
import { z } from "zod";
import type { SqlClient } from "../client.js";

const EventsSchema = z.array(TraceEventSchema);

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

// Opaque list cursor — (sealedAt, runId) of the last row, base64url. Newest first, house pagination shape.
function encodeCursor(meta: TrajectoryMeta): string {
  return Buffer.from(`${meta.sealedAt}|${meta.runId}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { sealedAt: string; runId: string } | undefined {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const split = raw.indexOf("|");
  if (split <= 0) return undefined;
  return { sealedAt: raw.slice(0, split), runId: raw.slice(split + 1) };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT);
}

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

  async list(tenant: string, opts?: { limit?: number; cursor?: string }): Promise<TrajectoryListResult> {
    const limit = clampLimit(opts?.limit);
    const after = opts?.cursor !== undefined ? decodeCursor(opts.cursor) : undefined;
    const sorted = [...this.rows.values()]
      .filter((r) => r.meta.tenant === tenant)
      .map((r) => r.meta)
      .sort((a, b) => b.sealedAt.localeCompare(a.sealedAt) || b.runId.localeCompare(a.runId))
      .filter(
        (m) =>
          after === undefined ||
          m.sealedAt < after.sealedAt ||
          (m.sealedAt === after.sealedAt && m.runId < after.runId),
      );
    const page = sorted.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      ...(sorted.length > limit && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
    };
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

  async list(tenant: string, opts?: { limit?: number; cursor?: string }): Promise<TrajectoryListResult> {
    const limit = clampLimit(opts?.limit);
    const after = opts?.cursor !== undefined ? decodeCursor(opts.cursor) : undefined;
    const conds = ["tenant = $1"];
    const vals: unknown[] = [tenant];
    if (after !== undefined) {
      conds.push("(sealed_at, run_id) < ($2::timestamptz, $3)");
      vals.push(after.sealedAt, after.runId);
    }
    const res = await this.client.query<{
      run_id: string;
      tenant: string;
      source: string;
      event_count: number;
      sealed_at: string | Date;
    }>(
      `SELECT run_id, tenant, source, event_count, sealed_at FROM everdict_trajectories
       WHERE ${conds.join(" AND ")}
       ORDER BY sealed_at DESC, run_id DESC
       LIMIT ${limit + 1}`,
      vals,
    );
    const metas: TrajectoryMeta[] = res.rows.map((row) => ({
      runId: row.run_id,
      tenant: row.tenant,
      source: row.source as TrajectoryMeta["source"],
      eventCount: Number(row.event_count),
      sealedAt: typeof row.sealed_at === "string" ? row.sealed_at : row.sealed_at.toISOString(),
    }));
    const page = metas.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      ...(metas.length > limit && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
    };
  }
}
