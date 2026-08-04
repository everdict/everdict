import {
  type SealInput,
  type SealedTrajectory,
  type TrajectoryListResult,
  type TrajectoryMeta,
  type TrajectorySegment,
  type TrajectoryStore,
  defaultEmitter,
  executionSegment,
  sealBody,
} from "@everdict/application-control";
import { spansToEvents } from "@everdict/domain";
import type { SqlClient } from "../client.js";
import { bodyOf, formatOf } from "./trajectory-body.js";

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

function isoOf(value: string | Date): string {
  return typeof value === "string" ? value : value.toISOString();
}

export class InMemoryTrajectoryStore implements TrajectoryStore {
  // One entry per run: the header (how it first arrived) plus one segment per emitter, insertion-ordered.
  private readonly rows = new Map<
    string,
    {
      tenant: string;
      source: TrajectoryMeta["source"];
      sealedAt: string;
      owner?: string;
      segments: TrajectorySegment[];
    }
  >();

  async seal(input: SealInput): Promise<TrajectoryMeta & { created: boolean }> {
    const emitter = input.emitter ?? defaultEmitter(input.source);
    const sealedAt = new Date().toISOString();
    const body = sealBody(input);
    // A `spans` body counts SPANS: that is what arrived, and the ingestion meter bills what arrives.
    const count = body.spans?.length ?? body.events.length;
    const segment: TrajectorySegment = {
      emitter,
      source: input.source,
      eventCount: count,
      ...(input.t0 !== undefined ? { t0: input.t0 } : {}),
      sealedAt,
      format: body.format,
      // Held as sealed; the projection is recomputed on read so it can never drift from the record.
      events: body.spans !== undefined ? spansToEvents(body.spans) : body.events,
      ...(body.spans !== undefined ? { spans: body.spans } : {}),
    };
    const existing = this.rows.get(input.runId);
    if (!existing) {
      this.rows.set(input.runId, {
        tenant: input.tenant,
        source: input.source,
        sealedAt,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        segments: [segment],
      });
      return { ...this.metaOf(input.runId), created: true };
    }
    if (existing.tenant !== input.tenant) {
      // Another workspace already owns this id — never touch it, never leak that it exists.
      return {
        runId: input.runId,
        tenant: input.tenant,
        source: input.source,
        eventCount: count,
        sealedAt,
        created: false,
      };
    }
    // First seal per emitter wins — a retried settle re-offers the same evidence and changes nothing.
    if (existing.segments.some((s) => s.emitter === emitter)) return { ...this.metaOf(input.runId), created: false };
    existing.segments.push(segment);
    return { ...this.metaOf(input.runId), created: true };
  }

  async get(tenant: string, runId: string): Promise<SealedTrajectory | undefined> {
    const row = this.rows.get(runId);
    if (!row || row.tenant !== tenant) return undefined;
    const segments = row.segments.map((s) => ({ ...s }));
    const execution = executionSegment(segments);
    return {
      meta: this.metaOf(runId),
      events: execution?.events ?? [],
      ...(execution !== undefined ? { executionEmitter: execution.emitter } : {}),
      segments,
    };
  }

  async list(
    tenant: string,
    opts?: { limit?: number; cursor?: string; viewer?: string },
  ): Promise<TrajectoryListResult> {
    const limit = clampLimit(opts?.limit);
    const after = opts?.cursor !== undefined ? decodeCursor(opts.cursor) : undefined;
    const viewer = opts?.viewer;
    const sorted = [...this.rows.keys()]
      .filter((runId) => {
        const row = this.rows.get(runId);
        if (row?.tenant !== tenant) return false;
        // Owned evidence is the owner's alone (the Pg twin's `owner IS NULL OR owner = $viewer`).
        return viewer === undefined || row.owner === undefined || row.owner === viewer;
      })
      .map((runId) => this.metaOf(runId))
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

  async ingestedSince(tenant: string, sinceIso: string): Promise<{ trajectories: number; events: number }> {
    let trajectories = 0;
    let events = 0;
    for (const [runId, row] of this.rows) {
      if (row.tenant !== tenant || row.sealedAt <= sinceIso) continue;
      trajectories += 1;
      events += this.metaOf(runId).eventCount;
    }
    return { trajectories, events };
  }

  async deleteOlderThan(cutoffIso: string): Promise<number> {
    let removed = 0;
    for (const [runId, row] of this.rows) {
      if (row.sealedAt < cutoffIso) {
        this.rows.delete(runId);
        removed += 1;
      }
    }
    return removed;
  }

  // The header a caller sees: how the trajectory first arrived, and every emitter's events counted together.
  private metaOf(runId: string): TrajectoryMeta {
    const row = this.rows.get(runId);
    if (!row) throw new Error(`trajectory ${runId} vanished mid-read`);
    return {
      runId,
      tenant: row.tenant,
      source: row.source,
      eventCount: row.segments.reduce((sum, s) => sum + s.eventCount, 0),
      sealedAt: row.sealedAt,
      ...(row.owner !== undefined ? { owner: row.owner } : {}),
    };
  }
}

interface PrimaryRow {
  run_id: string;
  tenant: string;
  source: string;
  emitter: string | null;
  event_count: number;
  segment_event_count: number;
  t0: string | Date | null;
  sealed_at: string | Date;
  owner: string | null; // mig 0116 — whose evidence this is; NULL = the workspace's
  body_format?: string | null; // mig 0118 — what the body holds; NULL = an event body sealed before N6
}

// Postgres-backed trajectory store (mig 0098 + 0104) — the header row carries the FIRST emitter's body;
// every later emitter lands in everdict_trajectory_segments. ON CONFLICT DO NOTHING makes both writes
// first-write-wins, per emitter.
export class PgTrajectoryStore implements TrajectoryStore {
  constructor(private readonly client: SqlClient) {}

  async seal(input: SealInput): Promise<TrajectoryMeta & { created: boolean }> {
    const emitter = input.emitter ?? defaultEmitter(input.source);
    const sealedAt = new Date().toISOString();
    const body = sealBody(input);
    const count = body.spans?.length ?? body.events.length;
    const bytes = JSON.stringify(body.spans ?? body.events);
    // RETURNING under ON CONFLICT DO NOTHING yields a row ONLY when this call inserted — `created` for free.
    const inserted = await this.client.query<{ run_id: string }>(
      `INSERT INTO everdict_trajectories (run_id, tenant, source, emitter, event_count, body, body_format, t0, sealed_at, owner)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10)
       ON CONFLICT (run_id) DO NOTHING
       RETURNING run_id`,
      [
        input.runId,
        input.tenant,
        input.source,
        emitter,
        count,
        bytes,
        body.format,
        input.t0 ?? null,
        sealedAt,
        input.owner ?? null,
      ],
    );
    if (inserted.rows.length > 0) {
      return {
        runId: input.runId,
        tenant: input.tenant,
        source: input.source,
        eventCount: count,
        sealedAt,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        created: true,
      };
    }
    // The trajectory exists. A re-offer from the SAME emitter is a retry (evidence is never rewritten); a
    // different emitter is a new plane and is kept beside the others.
    const primary = await this.primary(input.runId);
    if (!primary || primary.tenant !== input.tenant) {
      return {
        runId: input.runId,
        tenant: input.tenant,
        source: input.source,
        eventCount: count,
        sealedAt,
        created: false,
      };
    }
    if ((primary.emitter ?? primary.source) === emitter) return { ...metaOf(primary), created: false };
    const appended = await this.client.query<{ run_id: string }>(
      `INSERT INTO everdict_trajectory_segments (run_id, emitter, tenant, source, event_count, body, body_format, t0, sealed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9)
       ON CONFLICT (run_id, emitter) DO NOTHING
       RETURNING run_id`,
      [input.runId, emitter, input.tenant, input.source, count, bytes, body.format, input.t0 ?? null, sealedAt],
    );
    const created = appended.rows.length > 0;
    if (created) {
      await this.client.query(
        "UPDATE everdict_trajectories SET segment_event_count = segment_event_count + $1 WHERE run_id = $2",
        [count, input.runId],
      );
    }
    const refreshed = await this.primary(input.runId);
    return { ...metaOf(refreshed ?? primary), created };
  }

  async get(tenant: string, runId: string): Promise<SealedTrajectory | undefined> {
    const res = await this.client.query<PrimaryRow & { body: unknown }>(
      `SELECT run_id, tenant, source, emitter, event_count, segment_event_count, body, body_format, t0, sealed_at, owner
       FROM everdict_trajectories WHERE run_id = $1`,
      [runId],
    );
    const row = res.rows[0];
    if (!row || row.tenant !== tenant) return undefined;
    const sides = await this.client.query<{
      emitter: string;
      source: string;
      event_count: number;
      body: unknown;
      body_format: string | null;
      t0: string | Date | null;
      sealed_at: string | Date;
    }>(
      `SELECT emitter, source, event_count, body, body_format, t0, sealed_at FROM everdict_trajectory_segments
       WHERE run_id = $1 ORDER BY sealed_at ASC, emitter ASC`,
      [runId],
    );
    const segments: TrajectorySegment[] = [
      {
        emitter: row.emitter ?? row.source,
        source: row.source as TrajectoryMeta["source"],
        eventCount: Number(row.event_count),
        ...(row.t0 !== null ? { t0: isoOf(row.t0) } : {}),
        sealedAt: isoOf(row.sealed_at),
        format: formatOf(row.body_format),
        ...bodyOf(formatOf(row.body_format), row.body),
      },
      ...sides.rows.map((side) => ({
        emitter: side.emitter,
        source: side.source as TrajectoryMeta["source"],
        eventCount: Number(side.event_count),
        ...(side.t0 !== null ? { t0: isoOf(side.t0) } : {}),
        sealedAt: isoOf(side.sealed_at),
        format: formatOf(side.body_format),
        ...bodyOf(formatOf(side.body_format), side.body),
      })),
    ];
    const execution = executionSegment(segments);
    return {
      meta: metaOf(row),
      events: execution?.events ?? [],
      ...(execution !== undefined ? { executionEmitter: execution.emitter } : {}),
      segments,
    };
  }

  async list(
    tenant: string,
    opts?: { limit?: number; cursor?: string; viewer?: string },
  ): Promise<TrajectoryListResult> {
    const limit = clampLimit(opts?.limit);
    const after = opts?.cursor !== undefined ? decodeCursor(opts.cursor) : undefined;
    const conds = ["tenant = $1"];
    const vals: unknown[] = [tenant];
    if (after !== undefined) {
      conds.push(`(sealed_at, run_id) < ($${vals.length + 1}::timestamptz, $${vals.length + 2})`);
      vals.push(after.sealedAt, after.runId);
    }
    // Owned evidence is the owner's alone — in the WHERE, so the page stays full for everyone else.
    if (opts?.viewer !== undefined) {
      conds.push(`(owner IS NULL OR owner = $${vals.length + 1})`);
      vals.push(opts.viewer);
    }
    const res = await this.client.query<PrimaryRow>(
      `SELECT run_id, tenant, source, emitter, event_count, segment_event_count, t0, sealed_at, owner FROM everdict_trajectories
       WHERE ${conds.join(" AND ")}
       ORDER BY sealed_at DESC, run_id DESC
       LIMIT ${limit + 1}`,
      vals,
    );
    const metas = res.rows.map(metaOf);
    const page = metas.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      ...(metas.length > limit && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  async ingestedSince(tenant: string, sinceIso: string): Promise<{ trajectories: number; events: number }> {
    const res = await this.client.query<{ trajectories: string | number; events: string | number }>(
      `SELECT count(*) AS trajectories, COALESCE(SUM(event_count + segment_event_count), 0) AS events
       FROM everdict_trajectories WHERE tenant = $1 AND sealed_at > $2::timestamptz`,
      [tenant, sinceIso],
    );
    const row = res.rows[0];
    return { trajectories: Number(row?.trajectories ?? 0), events: Number(row?.events ?? 0) };
  }

  async deleteOlderThan(cutoffIso: string): Promise<number> {
    // Side segments go with the header (ON DELETE CASCADE) — never orphaned evidence.
    const res = await this.client.query<{ run_id: string }>(
      "DELETE FROM everdict_trajectories WHERE sealed_at < $1::timestamptz RETURNING run_id",
      [cutoffIso],
    );
    return res.rows.length;
  }

  private async primary(runId: string): Promise<PrimaryRow | undefined> {
    const res = await this.client.query<PrimaryRow>(
      `SELECT run_id, tenant, source, emitter, event_count, segment_event_count, t0, sealed_at, owner
       FROM everdict_trajectories WHERE run_id = $1`,
      [runId],
    );
    return res.rows[0];
  }
}

function metaOf(row: PrimaryRow): TrajectoryMeta {
  return {
    runId: row.run_id,
    tenant: row.tenant,
    source: row.source as TrajectoryMeta["source"],
    eventCount: Number(row.event_count) + Number(row.segment_event_count ?? 0),
    sealedAt: isoOf(row.sealed_at),
    ...(row.owner ? { owner: row.owner } : {}),
  };
}
