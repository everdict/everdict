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
import { UpstreamError } from "@everdict/contracts";
import { bodyOf, formatOf } from "./trajectory-body.js";

// The ops-scale trajectory store (native-observability N-O1 rung 2): the SAME TrajectoryStore port over
// ClickHouse — the swap is a composition-root env var (EVERDICT_CLICKHOUSE_URL), invisible to every
// consumer (the door, the browse surface, quota metering, retention, the perception decorator).
//
// Deliberately SDK-free: ClickHouse's HTTP interface is a URL — SELECTs go as parameterized queries
// (`{name:String}` placeholders + `param_<name>` args, so values never concatenate into SQL), INSERTs as
// JSONEachRow bodies. Two honest rung-2 simplifications, both documented:
// - `sealed_at`/`t0` are ISO-8601 Strings (lexicographic order == time order for a single format) — a
//   DateTime64 refinement can come with measurement, without a port change.
// - MergeTree has no unique key, so first-write-wins is enforced at READ (argMin/earliest row per
//   (run_id, emitter)) over a check-then-insert seal: a concurrent duplicate leaves a physically duplicate
//   row that every read resolves to the FIRST seal; retention removes duplicates with their run.
//
// The multi-plane rung needs no new table here — a segment IS a row, keyed by (run_id, emitter). The row
// that sealed first is the trajectory's header; the rest are its other planes.
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS everdict_trajectories (
  run_id String,
  tenant String,
  source String,
  emitter String DEFAULT '',
  event_count UInt32,
  body String,
  t0 String DEFAULT '',
  sealed_at String,
  owner String DEFAULT '',
  body_format String DEFAULT '',
  kind String DEFAULT '',
  label String DEFAULT '',
  INDEX idx_run run_id TYPE bloom_filter GRANULARITY 4
) ENGINE = MergeTree ORDER BY (tenant, sealed_at, run_id)`;

// Additive DDL for installs created before the multi-plane rung (idempotent, like the CREATE above).
const ADD_EMITTER_SQL = "ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS emitter String DEFAULT ''";
const ADD_T0_SQL = "ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS t0 String DEFAULT ''";
// Whose evidence a trajectory is (mig 0116's rung-2 twin). '' = the workspace's. No backfill here: unlike
// Postgres this store has no run ledger beside it to read an owner from, and it is opt-in + new.
const ADD_OWNER_SQL = "ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS owner String DEFAULT ''";
// What the body holds (N6's rung-2 twin of mig 0118). '' reads as 'events' — which is what every row written
// before spans became the record actually is. No backfill: sealed evidence is not rewritten.
const ADD_BODY_FORMAT_SQL = "ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS body_format String DEFAULT ''";
// What a piece of evidence IS, and what to call it on a browse row (mig 0124's rung-2 twin). '' = evidence
// that arrived with no run to name it. No backfill, for the same reason the owner column has none: this store
// has no run ledger beside it to read from.
const ADD_KIND_SQL = "ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS kind String DEFAULT ''";
const ADD_LABEL_SQL = "ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS label String DEFAULT ''";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

interface RunRow {
  run_id: string;
  tenant_run: string;
  source_run: string;
  event_count_run: number | string;
  sealed_at_run: string;
  owner_run: string;
  kind_run: string;
  label_run: string;
}

function rowToMeta(row: RunRow): TrajectoryMeta {
  return {
    runId: row.run_id,
    tenant: row.tenant_run,
    source: row.source_run as TrajectoryMeta["source"],
    eventCount: Number(row.event_count_run),
    sealedAt: row.sealed_at_run,
    ...(row.owner_run ? { owner: row.owner_run } : {}),
    ...(row.kind_run ? { kind: row.kind_run } : {}),
    ...(row.label_run ? { label: row.label_run } : {}),
  };
}

// The browse page's row predicate, applied INSIDE the per-emitter aggregate so both filters run before the
// LIMIT: a page filtered afterwards comes back short. Owned evidence is its owner's alone; the kind filter is
// how a reader asks for just their agent conversations among a workspace full of eval cases.
function listWhere(opts?: { viewer?: string; kind?: string }): string {
  const conds = ["tenant = {tenant:String}"];
  if (opts?.viewer !== undefined) conds.push("(owner = '' OR owner = {viewer:String})");
  if (opts?.kind !== undefined) conds.push("kind = {kind:String}");
  return conds.join(" AND ");
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
    await this.command(ADD_EMITTER_SQL, {});
    await this.command(ADD_T0_SQL, {});
    await this.command(ADD_OWNER_SQL, {});
    await this.command(ADD_BODY_FORMAT_SQL, {});
    await this.command(ADD_KIND_SQL, {});
    await this.command(ADD_LABEL_SQL, {});
  }

  async seal(input: SealInput): Promise<TrajectoryMeta & { created: boolean }> {
    const emitter = input.emitter ?? defaultEmitter(input.source);
    const sealedAt = new Date().toISOString();
    const body = sealBody(input);
    const count = body.spans?.length ?? body.events.length;
    const existing = await this.get(input.tenant, input.runId);
    const fallback = {
      runId: input.runId,
      tenant: input.tenant,
      source: input.source,
      eventCount: count,
      sealedAt,
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
    };
    if (existing) {
      // First seal per emitter wins — evidence is never rewritten; a new emitter is a new plane.
      if (existing.segments.some((s) => s.emitter === emitter)) return { ...existing.meta, created: false };
    } else {
      // No trajectory OR another workspace owns the id: a cross-tenant read returns undefined, so probe the
      // id itself before claiming it — never write a second tenant's row under the same run.
      const owned = await this.select<{ run_id: string }>(
        `SELECT run_id FROM ${this.table()} WHERE run_id = {runId:String} LIMIT 1`,
        { runId: input.runId },
      );
      if (owned.length > 0) return { ...fallback, created: false };
    }
    const row = {
      run_id: input.runId,
      tenant: input.tenant,
      source: input.source,
      emitter,
      event_count: count,
      body: JSON.stringify(body.spans ?? body.events),
      body_format: body.format,
      t0: input.t0 ?? "",
      sealed_at: sealedAt,
      owner: input.owner ?? "",
      kind: input.kind ?? "",
      label: input.label ?? "",
    };
    await this.command(`INSERT INTO ${this.table()} FORMAT JSONEachRow`, {}, JSON.stringify(row));
    if (!existing) return { ...fallback, created: true };
    return {
      ...existing.meta,
      eventCount: existing.meta.eventCount + count,
      created: true,
    };
  }

  async get(tenant: string, runId: string): Promise<SealedTrajectory | undefined> {
    // Earliest row per emitter wins (see the header) — the read-side half of first-write-wins.
    const rows = await this.select<{
      emitter: string;
      tenant_first: string;
      source_first: string;
      event_count_first: number | string;
      body_first: string;
      body_format_first: string;
      t0_first: string;
      sealed_at_first: string;
      owner_first: string;
    }>(
      `SELECT emitter,
              argMin(tenant, sealed_at) AS tenant_first,
              argMin(source, sealed_at) AS source_first,
              argMin(event_count, sealed_at) AS event_count_first,
              argMin(body, sealed_at) AS body_first,
              argMin(body_format, sealed_at) AS body_format_first,
              argMin(t0, sealed_at) AS t0_first,
              argMin(owner, sealed_at) AS owner_first,
              min(sealed_at) AS sealed_at_first
       FROM ${this.table()}
       WHERE run_id = {runId:String}
       GROUP BY emitter
       ORDER BY sealed_at_first ASC, emitter ASC`,
      { runId },
    );
    const header = rows[0];
    if (!header || header.tenant_first !== tenant) return undefined;
    const segments: TrajectorySegment[] = rows.map((row) => ({
      // Rows written before the multi-plane rung carry no emitter — they read as their arrival channel.
      emitter: row.emitter === "" ? row.source_first : row.emitter,
      source: row.source_first as TrajectoryMeta["source"],
      eventCount: Number(row.event_count_first),
      ...(row.t0_first !== "" ? { t0: row.t0_first } : {}),
      sealedAt: row.sealed_at_first,
      format: formatOf(row.body_format_first),
      ...bodyOf(formatOf(row.body_format_first), JSON.parse(row.body_first)),
    }));
    const execution = executionSegment(segments);
    return {
      meta: {
        runId,
        tenant,
        source: header.source_first as TrajectoryMeta["source"],
        eventCount: segments.reduce((sum, s) => sum + s.eventCount, 0),
        sealedAt: header.sealed_at_first,
        ...(header.owner_first ? { owner: header.owner_first } : {}),
      },
      events: execution?.events ?? [],
      ...(execution !== undefined ? { executionEmitter: execution.emitter } : {}),
      segments,
    };
  }

  async list(
    tenant: string,
    opts?: { limit?: number; cursor?: string; viewer?: string; kind?: string },
  ): Promise<TrajectoryListResult> {
    const limit = clampLimit(opts?.limit);
    const after = opts?.cursor !== undefined ? decodeCursor(opts.cursor) : undefined;
    // ClickHouse quirk (caught live): an alias is visible EVERYWHERE in its SELECT, so aliasing
    // `min(sealed_at) AS sealed_at` makes the argMin references resolve to the aggregate itself
    // (ILLEGAL_AGGREGATION). Hence the *_first / *_run names, mapped back below.
    const rows = await this.select<RunRow>(
      `SELECT run_id,
              argMin(tenant_first, sealed_at_first) AS tenant_run,
              argMin(source_first, sealed_at_first) AS source_run,
              sum(event_count_first) AS event_count_run,
              min(sealed_at_first) AS sealed_at_run,
              argMin(owner_first, sealed_at_first) AS owner_run,
              argMin(kind_first, sealed_at_first) AS kind_run,
              argMin(label_first, sealed_at_first) AS label_run
       FROM (${this.perEmitterSql(listWhere(opts))})
       GROUP BY run_id
       ${after !== undefined ? "HAVING (sealed_at_run, run_id) < ({afterSealedAt:String}, {afterRunId:String})" : ""}
       ORDER BY sealed_at_run DESC, run_id DESC
       LIMIT {limitPlusOne:UInt32}`,
      {
        tenant,
        limitPlusOne: String(limit + 1),
        ...(opts?.viewer !== undefined ? { viewer: opts.viewer } : {}),
        ...(opts?.kind !== undefined ? { kind: opts.kind } : {}),
        ...(after !== undefined ? { afterSealedAt: after.sealedAt, afterRunId: after.runId } : {}),
      },
    );
    const metas = rows.map(rowToMeta);
    const page = metas.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      ...(metas.length > limit && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  async ingestedSince(tenant: string, sinceIso: string): Promise<{ trajectories: number; events: number }> {
    const rows = await this.select<{ trajectories: number | string; events: number | string }>(
      `SELECT count() AS trajectories, sum(event_count_run) AS events FROM (
         SELECT run_id, sum(event_count_first) AS event_count_run, min(sealed_at_first) AS sealed_at_run
         FROM (${this.perEmitterSql("tenant = {tenant:String}")})
         GROUP BY run_id
       ) WHERE sealed_at_run > {since:String}`,
      { tenant, since: sinceIso },
    );
    const row = rows[0];
    return { trajectories: Number(row?.trajectories ?? 0), events: Number(row?.events ?? 0) };
  }

  async deleteOlderThan(cutoffIso: string): Promise<number> {
    // Cutoff applies to the TRAJECTORY (its earliest seal), never to a single plane — a later segment must
    // not survive its own run, and an early one must not drag a live run's planes away.
    const counted = await this.select<{ trajectories: number | string }>(
      `SELECT count() AS trajectories FROM (${this.expiredRunsSql()})`,
      { cutoff: cutoffIso },
    );
    const removed = Number(counted[0]?.trajectories ?? 0);
    if (removed > 0)
      await this.command(`DELETE FROM ${this.table()} WHERE run_id IN (${this.expiredRunsSql()})`, {
        cutoff: cutoffIso,
      });
    return removed;
  }

  // First-write-wins resolved per (run_id, emitter) — the shared inner query of every run-level aggregate.
  private perEmitterSql(where: string): string {
    return `SELECT run_id, emitter,
              argMin(tenant, sealed_at) AS tenant_first,
              argMin(source, sealed_at) AS source_first,
              argMin(event_count, sealed_at) AS event_count_first,
              argMin(owner, sealed_at) AS owner_first,
              argMin(kind, sealed_at) AS kind_first,
              argMin(label, sealed_at) AS label_first,
              min(sealed_at) AS sealed_at_first
       FROM ${this.table()} WHERE ${where} GROUP BY run_id, emitter`;
  }

  private expiredRunsSql(): string {
    return `SELECT run_id FROM ${this.table()} GROUP BY run_id HAVING min(sealed_at) < {cutoff:String}`;
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
