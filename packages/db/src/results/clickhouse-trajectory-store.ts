import type { TrajectoryListResult, TrajectoryMeta, TrajectoryStore } from "@everdict/application-control";
import { type TraceEvent, TraceEventSchema, UpstreamError } from "@everdict/contracts";
import { z } from "zod";

const EventsSchema = z.array(TraceEventSchema);

// The ops-scale trajectory store (native-observability N-O1 rung 2): the SAME TrajectoryStore port over
// ClickHouse — the swap is a composition-root env var (EVERDICT_CLICKHOUSE_URL), invisible to every
// consumer (the door, the browse surface, quota metering, retention, the perception decorator).
//
// Deliberately SDK-free: ClickHouse's HTTP interface is a URL — SELECTs go as parameterized queries
// (`{name:String}` placeholders + `param_<name>` args, so values never concatenate into SQL), INSERTs as
// JSONEachRow bodies. Two honest rung-2 simplifications, both documented:
// - `sealed_at` is an ISO-8601 String (lexicographic order == time order for a single format) — a
//   DateTime64 refinement can come with measurement, without a port change.
// - MergeTree has no unique key, so first-write-wins is enforced at READ (argMin/earliest-row per run_id)
//   over a check-then-insert seal: a concurrent duplicate leaves a physically duplicate row that every
//   read resolves to the FIRST seal; retention removes duplicates with their run.
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS everdict_trajectories (
  run_id String,
  tenant String,
  source String,
  event_count UInt32,
  body String,
  sealed_at String,
  INDEX idx_run run_id TYPE bloom_filter GRANULARITY 4
) ENGINE = MergeTree ORDER BY (tenant, sealed_at, run_id)`;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

interface MetaRow {
  run_id: string;
  tenant: string;
  source: string;
  event_count: number | string;
  sealed_at: string;
}

function rowToMeta(row: MetaRow): TrajectoryMeta {
  return {
    runId: row.run_id,
    tenant: row.tenant,
    source: row.source as TrajectoryMeta["source"],
    eventCount: Number(row.event_count),
    sealedAt: row.sealed_at,
  };
}

function encodeCursor(meta: TrajectoryMeta): string {
  return Buffer.from(`${meta.sealedAt}|${meta.runId}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { sealedAt: string; runId: string } | undefined {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const split = raw.indexOf("|");
  if (split <= 0) return undefined;
  return { sealedAt: raw.slice(0, split), runId: raw.slice(split + 1) };
}

export class ClickHouseTrajectoryStore implements TrajectoryStore {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: { url: string; database?: string },
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  // Idempotent DDL — called once by the composition root (one table; a migration framework would be
  // ceremony). Additive changes ship as new IF-NOT-EXISTS statements here.
  async ensureSchema(): Promise<void> {
    await this.command(SCHEMA_SQL, {});
  }

  async seal(input: {
    runId: string;
    tenant: string;
    source: TrajectoryMeta["source"];
    events: TraceEvent[];
  }): Promise<TrajectoryMeta & { created: boolean }> {
    const existing = await this.get(input.tenant, input.runId);
    if (existing) return { ...existing.meta, created: false }; // first seal wins — evidence is never rewritten
    const sealedAt = new Date().toISOString();
    const row = {
      run_id: input.runId,
      tenant: input.tenant,
      source: input.source,
      event_count: input.events.length,
      body: JSON.stringify(input.events),
      sealed_at: sealedAt,
    };
    await this.command(`INSERT INTO ${this.table()} FORMAT JSONEachRow`, {}, JSON.stringify(row));
    return {
      runId: input.runId,
      tenant: input.tenant,
      source: input.source,
      eventCount: input.events.length,
      sealedAt,
      created: true,
    };
  }

  async get(tenant: string, runId: string): Promise<{ meta: TrajectoryMeta; events: TraceEvent[] } | undefined> {
    // Earliest row wins (see the header) — the read-side half of first-write-wins.
    const rows = await this.select<MetaRow & { body: string }>(
      `SELECT run_id, tenant, source, event_count, body, sealed_at FROM ${this.table()}
       WHERE run_id = {runId:String} ORDER BY sealed_at ASC LIMIT 1`,
      { runId },
    );
    const row = rows[0];
    if (!row || row.tenant !== tenant) return undefined;
    return { meta: rowToMeta(row), events: EventsSchema.parse(JSON.parse(row.body)) };
  }

  async list(tenant: string, opts?: { limit?: number; cursor?: string }): Promise<TrajectoryListResult> {
    const limit = clampLimit(opts?.limit);
    const after = opts?.cursor !== undefined ? decodeCursor(opts.cursor) : undefined;
    // ClickHouse quirk (caught live): an alias is visible EVERYWHERE in its SELECT, so aliasing
    // `min(sealed_at) AS sealed_at` makes the argMin references resolve to the aggregate itself
    // (ILLEGAL_AGGREGATION). Hence the *_first names, mapped back below.
    const rows = await this.select<{
      run_id: string;
      tenant_first: string;
      source_first: string;
      event_count_first: number | string;
      sealed_at_first: string;
    }>(
      `SELECT run_id,
              argMin(tenant, sealed_at) AS tenant_first,
              argMin(source, sealed_at) AS source_first,
              argMin(event_count, sealed_at) AS event_count_first,
              min(sealed_at) AS sealed_at_first
       FROM ${this.table()}
       WHERE tenant = {tenant:String}
       GROUP BY run_id
       ${after !== undefined ? "HAVING (sealed_at_first, run_id) < ({afterSealedAt:String}, {afterRunId:String})" : ""}
       ORDER BY sealed_at_first DESC, run_id DESC
       LIMIT {limitPlusOne:UInt32}`,
      {
        tenant,
        limitPlusOne: String(limit + 1),
        ...(after !== undefined ? { afterSealedAt: after.sealedAt, afterRunId: after.runId } : {}),
      },
    );
    const metas = rows.map((row) =>
      rowToMeta({
        run_id: row.run_id,
        tenant: row.tenant_first,
        source: row.source_first,
        event_count: row.event_count_first,
        sealed_at: row.sealed_at_first,
      }),
    );
    const page = metas.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      ...(metas.length > limit && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  async ingestedSince(tenant: string, sinceIso: string): Promise<{ trajectories: number; events: number }> {
    const rows = await this.select<{ trajectories: number | string; events: number | string }>(
      `SELECT count() AS trajectories, sum(events_first) AS events FROM (
         SELECT run_id, argMin(event_count, sealed_at) AS events_first, min(sealed_at) AS sealed_at_first
         FROM ${this.table()} WHERE tenant = {tenant:String} GROUP BY run_id
       ) WHERE sealed_at_first > {since:String}`,
      { tenant, since: sinceIso },
    );
    const row = rows[0];
    return { trajectories: Number(row?.trajectories ?? 0), events: Number(row?.events ?? 0) };
  }

  async deleteOlderThan(cutoffIso: string): Promise<number> {
    const counted = await this.select<{ trajectories: number | string }>(
      `SELECT count(DISTINCT run_id) AS trajectories FROM ${this.table()} WHERE sealed_at < {cutoff:String}`,
      { cutoff: cutoffIso },
    );
    const removed = Number(counted[0]?.trajectories ?? 0);
    if (removed > 0)
      await this.command(`DELETE FROM ${this.table()} WHERE sealed_at < {cutoff:String}`, { cutoff: cutoffIso });
    return removed;
  }

  private table(): string {
    return `${this.opts.database ?? "default"}.everdict_trajectories`;
  }

  private async select<T>(sql: string, params: Record<string, string>): Promise<T[]> {
    const text = await this.request(`${sql} FORMAT JSONEachRow`, params);
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as T);
  }

  private async command(sql: string, params: Record<string, string>, body?: string): Promise<void> {
    await this.request(sql, params, body);
  }

  // ClickHouse HTTP: the QUERY travels as the `query` URL param (with {name:Type} placeholders bound via
  // param_<name> args — values never concatenate into SQL); an INSERT's data rides the POST body.
  private async request(sql: string, params: Record<string, string>, body?: string): Promise<string> {
    const url = new URL(this.opts.url);
    url.searchParams.set("query", sql);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(`param_${key}`, value);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "POST", body: body ?? "" });
    } catch (err) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { store: "clickhouse" },
        `ClickHouse unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    if (!res.ok)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { store: "clickhouse", status: res.status },
        `ClickHouse query failed (${res.status}): ${text.slice(0, 300)}`,
      );
    return text;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT);
}
