import {
  MAX_LEGACY_BODY_BYTES,
  type SealInput,
  type SealedTrajectory,
  type TrajectoryEventsResult,
  type TrajectoryListResult,
  type TrajectoryMeta,
  type TrajectoryPayloadRef,
  type TrajectorySegment,
  type TrajectoryStore,
  type TrajectoryUsage,
  type TrajectoryWindow,
  clampWindow,
  defaultEmitter,
  executionEmitterOf,
  executionSegment,
  pageOf,
  sealBody,
  segmentDeclaresAttempt,
  serializedBytes,
  trajectoryForAttempt,
} from "@everdict/application-control";
import { type RunUsageSummary, RunUsageSummarySchema } from "@everdict/contracts";
import type { SpanBatchFacts } from "@everdict/domain";
import type { SqlClient } from "../client.js";
import { bodyOf, formatOf, pageBodyOf } from "./trajectory-body.js";

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

// One sealed item and the size the WRITER measured, because the reader must be able to budget a page without
// first materializing the thing it is budgeting (mig 0200).
export interface SizedItem {
  body: unknown;
  bytes: number;
}

// The items of a plane, in the order the plane is paged in — projection order for a spans plane (the seal
// sorted it), arrival order for an events one.
export function sizedItems(body: {
  format: string;
  events: readonly unknown[];
  spans?: readonly unknown[];
}): SizedItem[] {
  const items = body.spans ?? body.events;
  return items.map((item) => ({ body: item, bytes: serializedBytes(item) }));
}

// Which plane a window means, from the planes the caller is allowed to see. Shared by every impl so a window
// naming no emitter resolves the same everywhere.
export function planeFor<T extends { emitter: string }>(planes: T[], emitter: string | undefined): T | undefined {
  const wanted = emitter ?? executionEmitterOf(planes.map((p) => p.emitter));
  return wanted === undefined ? undefined : planes.find((p) => p.emitter === wanted);
}

export class InMemoryTrajectoryStore implements TrajectoryStore {
  // One entry per run: the header (how it first arrived) plus one plane per emitter, insertion-ordered.
  private readonly rows = new Map<
    string,
    {
      tenant: string;
      source: TrajectoryMeta["source"];
      sealedAt: string;
      owner?: string;
      kind?: string;
      label?: string;
      preview?: string;
      segments: TrajectorySegment[];
      // Per-emitter economics, derived at seal (see TrajectoryUsage). Kept BESIDE the segments rather than on
      // them: `TrajectorySegment` is what a read hands out, and a field no consumer declares would ride along
      // unreadable — the excess-property shape rule `typescript` warns about.
      usage: Map<string, RunUsageSummary>;
      // …and the bodies, SPLIT the way the persistent stores split them (mig 0200). The twin pages the same
      // way for the same reason it validates the same way: a double that materializes what production pages
      // cannot see a paging defect.
      items: Map<string, SizedItem[]>;
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
      // WHOSE evidence this plane is (mig 0176) — several physical executions can seal under one run id.
      ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
      // …and what a PAGE of it will need in order to project like the whole (mig 0200).
      ...(body.batch !== undefined ? { batch: body.batch } : {}),
    };
    const existing = this.rows.get(input.runId);
    if (!existing) {
      this.rows.set(input.runId, {
        tenant: input.tenant,
        source: input.source,
        sealedAt,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.preview !== undefined ? { preview: input.preview } : {}),
        segments: [segment],
        usage: new Map(body.usage !== undefined ? [[emitter, body.usage]] : []),
        items: new Map([[emitter, sizedItems(body)]]),
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
    existing.items.set(emitter, sizedItems(body));
    if (body.usage !== undefined) existing.usage.set(emitter, body.usage);
    return { ...this.metaOf(input.runId), created: true };
  }

  async planes(tenant: string, runId: string, opts?: { attemptId: string }): Promise<SealedTrajectory | undefined> {
    const row = this.rows.get(runId);
    if (!row || row.tenant !== tenant) return undefined;
    const segments = row.segments.map((s) => ({ ...s }));
    const execution = executionSegment(segments);
    const sealed: SealedTrajectory = {
      meta: this.metaOf(runId),
      ...(execution !== undefined ? { executionEmitter: execution.emitter } : {}),
      segments,
    };
    // One plane per emitter here (the Map is keyed that way), so the exact-identity read is the shared rule
    // applied to the resolved trajectory — see trajectoryForAttempt.
    return opts === undefined ? sealed : trajectoryForAttempt(sealed, opts.attemptId);
  }

  async events(tenant: string, runId: string, window: TrajectoryWindow): Promise<TrajectoryEventsResult> {
    const row = this.rows.get(runId);
    if (!row || row.tenant !== tenant) return { kind: "absent" };
    // The identity filter travels with the WINDOW, not only with the plane list: a caller holding a receipt
    // asks for that attempt's bytes, and serving another execution's from a read that merely returns events
    // would be the substitution the identity read exists to refuse.
    const visible =
      window.attemptId === undefined
        ? row.segments
        : row.segments.filter((s) => segmentDeclaresAttempt(s, window.attemptId as string));
    const plane = planeFor(visible, window.emitter);
    if (plane === undefined) return { kind: "absent" };
    const items = row.items.get(plane.emitter) ?? [];
    const { limit, maxBytes, after } = clampWindow(window);
    const { slice, nextAfter } = pageOf(items, after, limit, maxBytes, (item) => item.bytes);
    return {
      kind: "page",
      page: {
        emitter: plane.emitter,
        format: plane.format,
        ...pageBodyOf(
          plane.format,
          slice.map((item) => item.body),
          plane.batch,
        ),
        ...(nextAfter !== undefined ? { nextAfter } : {}),
        ...(plane.batch !== undefined ? { batch: plane.batch } : {}),
        eventCount: plane.eventCount,
      },
    };
  }

  async usage(tenant: string, runId: string): Promise<TrajectoryUsage> {
    const row = this.rows.get(runId);
    if (!row || row.tenant !== tenant) return { kind: "absent" };
    // The SAME resolution `events` uses for its default plane, over the emitter names alone — so the cost
    // this reports and the stream a judge reads are always about one plane.
    const emitter = executionEmitterOf(row.segments.map((s) => s.emitter));
    const usage = emitter === undefined ? undefined : row.usage.get(emitter);
    return usage === undefined ? { kind: "unknown", reason: "sealed_before_derivation" } : { kind: "derived", usage };
  }

  async list(
    tenant: string,
    opts?: { limit?: number; cursor?: string; viewer?: string; kind?: string },
  ): Promise<TrajectoryListResult> {
    const limit = clampLimit(opts?.limit);
    const after = opts?.cursor !== undefined ? decodeCursor(opts.cursor) : undefined;
    const viewer = opts?.viewer;
    const sorted = [...this.rows.keys()]
      .filter((runId) => {
        const row = this.rows.get(runId);
        if (row?.tenant !== tenant) return false;
        if (opts?.kind !== undefined && row.kind !== opts.kind) return false;
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

  // The twin of the Pg reader (arch-review 120): every payload ref the doomed rows hold, so the decorator can
  // delete the bytes before the rows that name them are gone.
  async payloadRefsOlderThan(cutoffIso: string, limit: number, after?: string): Promise<TrajectoryPayloadRef[]> {
    const found: TrajectoryPayloadRef[] = [];
    const seen = new Set<string>();
    const walk = (value: unknown, tenant: string, runId: string): void => {
      if (typeof value === "string") {
        // The owner travels WITH the ref: the row it was read from is the only thing that says which
        // trajectory holds it, and a ref alone is a string a producer can author (arch-review 121).
        if (value.startsWith("artifact://") && !seen.has(value)) {
          seen.add(value);
          found.push({ tenant, runId, ref: value });
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item, tenant, runId);
        return;
      }
      if (value !== null && typeof value === "object")
        for (const item of Object.values(value)) walk(item, tenant, runId);
    };
    for (const [runId, row] of this.rows.entries()) if (row.sealedAt < cutoffIso) walk(row, row.tenant, runId);
    // Ordered by ref so `after` is a stable cursor — the twin pages the way the adapters do, or the sweep's
    // drain is a property no unit test can see.
    return found
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
      .filter((r) => after === undefined || r.ref > after)
      .slice(0, limit);
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
      ...(row.kind !== undefined ? { kind: row.kind } : {}),
      ...(row.label !== undefined ? { label: row.label } : {}),
      ...(row.preview !== undefined ? { preview: row.preview } : {}),
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
  kind?: string | null; // mig 0124 — what it is (RUN_KINDS); NULL = arrived with no run to name it
  label?: string | null; // mig 0124 — the human handle (conversation title · case id · harness)
  preview?: string | null; // mig 0168 — the one-line excerpt naming the WORK; NULL = a body with no phrase to quote
  attempt_id?: string | null; // mig 0176 — WHICH physical attempt sealed it; NULL = the producer did not say
}

// One plane as the body-free read returns it, whichever table it lives in (mig 0200).
interface PlaneRow {
  emitter: string;
  source: string;
  event_count: number;
  t0: string | Date | null;
  sealed_at: string | Date;
  body_format: string | null;
  attempt_id: string | null;
  body_split: boolean;
  batch: unknown;
  tenant: string;
  header: boolean;
}

function planeOf(row: PlaneRow): TrajectorySegment {
  return {
    emitter: row.emitter,
    source: row.source as TrajectoryMeta["source"],
    eventCount: Number(row.event_count),
    ...(row.t0 !== null ? { t0: isoOf(row.t0) } : {}),
    sealedAt: isoOf(row.sealed_at),
    format: formatOf(row.body_format),
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    ...(row.batch !== null && row.batch !== undefined ? { batch: row.batch as SpanBatchFacts } : {}),
  };
}

// Postgres-backed trajectory store (mig 0098 + 0104 + 0200) — the header row carries the FIRST emitter's
// plane; every later emitter lands in everdict_trajectory_segments; both keep their EVENTS in
// everdict_trajectory_events, one row each. ON CONFLICT DO NOTHING makes the plane writes first-write-wins,
// per emitter.
export class PgTrajectoryStore implements TrajectoryStore {
  constructor(private readonly client: SqlClient) {}

  async seal(input: SealInput): Promise<TrajectoryMeta & { created: boolean }> {
    const emitter = input.emitter ?? defaultEmitter(input.source);
    const sealedAt = new Date().toISOString();
    const body = sealBody(input);
    const count = body.spans?.length ?? body.events.length;
    const items = sizedItems(body);
    const usage = body.usage !== undefined ? JSON.stringify(body.usage) : null;
    const batch = body.batch !== undefined ? JSON.stringify(body.batch) : null;
    // ── THE BODY COLUMN STAYS, EMPTY, ON A SPLIT PLANE ────────────────────────────────────────────
    //
    // `body` is NOT NULL and mig 0200 deliberately does not relax that: during a rolling deploy a replica on
    // the previous release still reads it, and `[]` degrades that replica to "renders empty" where a NULL
    // would crash its schema parse. The bytes are in everdict_trajectory_events throughout.
    const EMPTY = "[]";
    // RETURNING under ON CONFLICT DO NOTHING yields a row ONLY when this call inserted — `created` for free.
    const inserted = await this.client.query<{ run_id: string }>(
      `INSERT INTO everdict_trajectories (run_id, tenant, source, emitter, event_count, body, body_format, t0, sealed_at, owner, kind, label, preview, attempt_id, usage, body_split, batch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11, $12, $13, $14, $15, true, $16)
       ON CONFLICT (run_id) DO NOTHING
       RETURNING run_id`,
      [
        input.runId,
        input.tenant,
        input.source,
        emitter,
        count,
        EMPTY,
        body.format,
        input.t0 ?? null,
        sealedAt,
        input.owner ?? null,
        input.kind ?? null,
        input.label ?? null,
        input.preview ?? null,
        input.attemptId ?? null,
        // Derived from the body this statement is writing, in the same statement — so a row can never hold
        // evidence whose cost was computed from something else. NULL when the body would not project: the
        // read reports that as unknown, never as zero (mig 0199).
        usage,
        batch,
      ],
    );
    if (inserted.rows.length > 0) {
      await this.writeEvents(input.runId, emitter, items);
      return {
        runId: input.runId,
        tenant: input.tenant,
        source: input.source,
        eventCount: count,
        sealedAt,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.preview !== undefined ? { preview: input.preview } : {}),
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
      `INSERT INTO everdict_trajectory_segments (run_id, emitter, tenant, source, event_count, body, body_format, t0, sealed_at, attempt_id, usage, body_split, batch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11, true, $12)
       ON CONFLICT (run_id, emitter) DO NOTHING
       RETURNING run_id`,
      [
        input.runId,
        emitter,
        input.tenant,
        input.source,
        count,
        EMPTY,
        body.format,
        input.t0 ?? null,
        sealedAt,
        input.attemptId ?? null,
        usage,
        batch,
      ],
    );
    const created = appended.rows.length > 0;
    if (created) {
      await this.writeEvents(input.runId, emitter, items);
      await this.client.query(
        "UPDATE everdict_trajectories SET segment_event_count = segment_event_count + $1 WHERE run_id = $2",
        [count, input.runId],
      );
    }
    const refreshed = await this.primary(input.runId);
    return { ...metaOf(refreshed ?? primary), created };
  }

  // One row per event, seq 1..N in PAGING order. Written AFTER the plane row wins its ON CONFLICT, so two
  // concurrent seals of the same emitter cannot interleave rows: the loser never reaches this.
  private async writeEvents(runId: string, emitter: string, items: SizedItem[]): Promise<void> {
    if (items.length === 0) return;
    // One statement, unnested — a per-event round trip would make sealing a long-horizon run O(N) round trips.
    //
    // ⚠️ `body_in.value` IS QUALIFIED, AND THE UNQUALIFIED VERSION SHIPPED (design review). Both `unnest`
    // aliases expose a column called `value`, so a bare `value` here is `column reference "value" is
    // ambiguous` — every split-plane seal failed against real Postgres from the moment this statement was
    // written. Nothing caught it: `InMemoryTrajectoryStore` keeps its rows in a Map and the fake `SqlClient`
    // asserts on the SQL TEXT, so both answer happily to a statement Postgres refuses to plan. It was found
    // by TRUST-190, the first scenario to execute this path against an engine.
    await this.client.query(
      `INSERT INTO everdict_trajectory_events (run_id, emitter, seq, body, bytes)
       SELECT $1, $2, ordinality, body_in.value, (bytes_in.value)::int
         FROM unnest($3::jsonb[]) WITH ORDINALITY AS body_in(value, ordinality)
         JOIN unnest($4::int[]) WITH ORDINALITY AS bytes_in(value, ordinality) USING (ordinality)
       ON CONFLICT (run_id, emitter, seq) DO NOTHING`,
      [runId, emitter, items.map((item) => JSON.stringify(item.body)), items.map((item) => item.bytes)],
    );
  }

  async planes(tenant: string, runId: string, opts?: { attemptId: string }): Promise<SealedTrajectory | undefined> {
    const rows = await this.planeRows(tenant, runId);
    const header = rows.find((r) => r.header);
    if (!header || header.tenant !== tenant) return undefined;
    const primary = await this.primary(runId);
    if (!primary) return undefined;
    const segments = rows.map(planeOf);
    const execution = executionSegment(segments);
    const sealed: SealedTrajectory = {
      meta: metaOf(primary),
      ...(execution !== undefined ? { executionEmitter: execution.emitter } : {}),
      segments,
    };
    // The header row is UNIQUE on run_id and each segment on (run_id, emitter), so Postgres cannot hold two
    // rows for one plane and the identity read is a filter, not a tie-break — the same rule ClickHouse has to
    // state in SQL because there the duplicates are rows.
    return opts === undefined ? sealed : trajectoryForAttempt(sealed, opts.attemptId);
  }

  async events(tenant: string, runId: string, window: TrajectoryWindow): Promise<TrajectoryEventsResult> {
    const rows = await this.planeRows(tenant, runId);
    const header = rows.find((r) => r.header);
    if (!header || header.tenant !== tenant) return { kind: "absent" };
    const visible =
      window.attemptId === undefined
        ? rows
        : rows.filter((r) => segmentDeclaresAttempt(planeOf(r), window.attemptId as string));
    const row = planeFor(visible, window.emitter);
    if (row === undefined) return { kind: "absent" };
    const plane = planeOf(row);
    const { limit, maxBytes, after } = clampWindow(window);
    if (!row.body_split) return this.legacyPage(runId, row, plane, { limit, maxBytes, after });

    // ── THE WINDOW, IN SQL ────────────────────────────────────────────────────────────────────────
    //
    // Two levels on purpose. The inner LIMIT bounds how many rows are considered WITHOUT selecting `body`,
    // so the byte budget is decided over sizes alone; only the rows that survive it are joined back for
    // their bodies. Selecting `body` in the limited scan would haul a full page before the budget could
    // shorten it, which is the defect one layer down.
    //
    // `rn = 1 OR` keeps the first row unconditionally: a page that comes back empty because its first event
    // alone exceeds the budget is a stream that never advances.
    const page = await this.client.query<{ seq: number; body: unknown }>(
      `WITH win AS (
         SELECT seq,
                sum(bytes) OVER (ORDER BY seq) AS running,
                row_number() OVER (ORDER BY seq) AS rn
           FROM (SELECT seq, bytes FROM everdict_trajectory_events
                  WHERE run_id = $1 AND emitter = $2 AND seq > $3
                  ORDER BY seq LIMIT $4) lim
       )
       SELECT e.seq, e.body
         FROM everdict_trajectory_events e
         JOIN win ON win.seq = e.seq
        WHERE e.run_id = $1 AND e.emitter = $2 AND (win.rn = 1 OR win.running <= $5)
        ORDER BY e.seq`,
      [runId, row.emitter, after, limit, maxBytes],
    );
    const lastSeq = page.rows[page.rows.length - 1]?.seq;
    return {
      kind: "page",
      page: {
        emitter: plane.emitter,
        format: plane.format,
        ...pageBodyOf(
          plane.format,
          page.rows.map((r) => r.body),
          plane.batch,
        ),
        // seq is contiguous 1..eventCount (the seal writes it that way), so "is there more" needs no probe.
        ...(lastSeq !== undefined && Number(lastSeq) < plane.eventCount ? { nextAfter: Number(lastSeq) } : {}),
        ...(plane.batch !== undefined ? { batch: plane.batch } : {}),
        eventCount: plane.eventCount,
      },
    };
  }

  // A plane sealed before mig 0200 is one jsonb blob, and there is no window of a blob that does not cost the
  // whole blob. Above the ceiling the honest answer is a refusal naming the size and the repair — never an
  // empty page, which every reader would take as "the run did nothing".
  private async legacyPage(
    runId: string,
    row: PlaneRow,
    plane: TrajectorySegment,
    page: { limit: number; maxBytes: number; after: number },
  ): Promise<TrajectoryEventsResult> {
    const table = row.header ? "everdict_trajectories" : "everdict_trajectory_segments";
    const where = row.header ? "run_id = $1" : "run_id = $1 AND emitter = $2";
    const params = row.header ? [runId] : [runId, row.emitter];
    // pg_column_size reads the STORED (toasted, compressed) size — no detoast, which is the only way to ask
    // "is this too big to read" without reading it.
    const sized = await this.client.query<{ stored: number }>(
      `SELECT pg_column_size(body) AS stored FROM ${table} WHERE ${where}`,
      params,
    );
    const storedBytes = Number(sized.rows[0]?.stored ?? 0);
    if (storedBytes > MAX_LEGACY_BODY_BYTES)
      return { kind: "too_large", storedBytes, limitBytes: MAX_LEGACY_BODY_BYTES, emitter: plane.emitter };
    const read = await this.client.query<{ body: unknown }>(`SELECT body FROM ${table} WHERE ${where}`, params);
    const whole = bodyOf(plane.format, read.rows[0]?.body ?? []);
    // Page the RECORD (spans when there are spans), so a legacy plane and a split one page over the same unit
    // and `nextAfter` means the same thing on both.
    const units: unknown[] = whole.spans ?? whole.events;
    const { slice, nextAfter } = pageOf(units, page.after, page.limit, page.maxBytes, serializedBytes);
    return {
      kind: "page",
      page: {
        emitter: plane.emitter,
        format: plane.format,
        ...pageBodyOf(plane.format, slice, plane.batch),
        ...(nextAfter !== undefined ? { nextAfter } : {}),
        ...(plane.batch !== undefined ? { batch: plane.batch } : {}),
        eventCount: plane.eventCount,
      },
    };
  }

  // Emitters and summaries ONLY — the `body` column is deliberately absent from this statement, because
  // hauling it is the entire defect this read exists to close. One round trip, both planes, no detoast.
  async usage(tenant: string, runId: string): Promise<TrajectoryUsage> {
    const res = await this.client.query<{
      emitter: string;
      tenant: string;
      usage: unknown;
      header: boolean;
    }>(
      `SELECT COALESCE(emitter, source) AS emitter, tenant, usage, true AS header
         FROM everdict_trajectories WHERE run_id = $1 AND tenant = $2
       UNION ALL
       SELECT COALESCE(emitter, source) AS emitter, tenant, usage, false AS header
         FROM everdict_trajectory_segments WHERE run_id = $1 AND tenant = $2`,
      [runId, tenant],
    );
    // Workspace-scoped in SQL, the same way `planes` is — and this comment used to say the opposite, that
    // scoping "is decided by the HEADER row, exactly as `planes` decides it". That was true of both until the
    // plane read was scoped one commit earlier and this sibling was not, which is the one-lane-only shape at
    // its shortest distance yet: two queries over the same two tables, in one file, and a comment citing the
    // lane that had just stopped working that way (arch-review 122).
    const header = res.rows.find((r) => r.header);
    if (!header || header.tenant !== tenant) return { kind: "absent" };
    const emitter = executionEmitterOf(res.rows.map((r) => r.emitter));
    const row = res.rows.find((r) => r.emitter === emitter);
    if (!row || row.usage === null || row.usage === undefined)
      return { kind: "unknown", reason: "sealed_before_derivation" };
    // Validated at the boundary like every other jsonb column: a hand-edited row is a bad request, not a
    // NaN that rides into an invoice.
    return { kind: "derived", usage: RunUsageSummarySchema.parse(row.usage) };
  }

  async list(
    tenant: string,
    opts?: { limit?: number; cursor?: string; viewer?: string; kind?: string },
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
    // Same reason the owner predicate is here: a kind filtered after the LIMIT hands back a short page.
    if (opts?.kind !== undefined) {
      conds.push(`kind = $${vals.length + 1}`);
      vals.push(opts.kind);
    }
    const res = await this.client.query<PrimaryRow>(
      `SELECT run_id, tenant, source, emitter, event_count, segment_event_count, t0, sealed_at, owner, kind, label, preview FROM everdict_trajectories
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

  // ── WHAT RETENTION IS ABOUT TO DESTROY THE ONLY POINTER TO (arch-review 120) ────────────────────
  //
  // An offloaded payload is named ONLY by the event row carrying its ref, so deleting the rows removes the
  // last enumeration of those objects. This is the read the offloading decorator makes BEFORE the delete —
  // after it there is nothing left to ask.
  //
  // Both split and unsplit planes: a legacy single-blob body holds its events inside one jsonb document, and
  // its refs are just as real. `$.**` walks either shape at any depth, and `DISTINCT` collapses the many
  // events that share one digest-addressed payload.
  //
  // ⚠️ THE FIRST VERSION OF THIS QUERY WAS A SYNTAX ERROR, AND NOTHING COULD SEE IT (design review).
  // It read `'$.**{0 to 6}.*ref'`, trying to say "any key ending in ref" — which SQL/JSON path cannot
  // express, so Postgres answered `syntax error at end of jsonpath input` on EVERY call. Because the
  // decorator awaits this read before deleting anything, that made the whole trajectory retention sweep
  // throw in every Postgres deployment: not just the object cleanup, the row deletion too.
  //
  // Nothing caught it because the in-memory twin has its own JavaScript walk, so every unit test passed
  // against an implementation that is not the one production runs. That is rule `testing`'s law verbatim —
  // a decision that lives in the ADAPTER is certified by a real-Postgres scenario or by nothing — and the
  // fix ships with `payload-retention.trust.test.ts` so this query is executed by an engine, not by a fake.
  //
  // Matching is by VALUE, never by key name: a whole string that STARTS WITH the scheme. A key-name rule
  // would miss a ref stored under any other name, and a substring rule would match an agent's own output
  // quoting somebody else's ref — and retention deletes what it matches.
  async payloadRefsOlderThan(cutoffIso: string, limit: number, after?: string): Promise<TrajectoryPayloadRef[]> {
    const res = await this.client.query<{ tenant: string; run_id: string; ref: string }>(
      `SELECT DISTINCT tenant, run_id, ref FROM (
         SELECT t.tenant, t.run_id, jsonb_path_query(e.body, '$.**') #>> '{}' AS ref
           FROM everdict_trajectory_events e
           JOIN everdict_trajectories t ON t.run_id = e.run_id
          WHERE t.sealed_at < $1::timestamptz
         UNION ALL
         SELECT t.tenant, t.run_id, jsonb_path_query(t.body, '$.**') #>> '{}' AS ref
           FROM everdict_trajectories t
          WHERE t.sealed_at < $1::timestamptz AND t.body IS NOT NULL
       ) refs
       WHERE ref LIKE 'artifact://%' AND ($3::text IS NULL OR ref > $3)
       ORDER BY ref
       LIMIT $2`,
      [cutoffIso, limit, after ?? null],
    );
    return res.rows.map((r) => ({ tenant: r.tenant, runId: r.run_id, ref: r.ref }));
  }

  async deleteOlderThan(cutoffIso: string): Promise<number> {
    // Side segments AND every event row go with the header (ON DELETE CASCADE) — never orphaned evidence.
    const res = await this.client.query<{ run_id: string }>(
      "DELETE FROM everdict_trajectories WHERE sealed_at < $1::timestamptz RETURNING run_id",
      [cutoffIso],
    );
    return res.rows.length;
  }

  // Every plane of one trajectory, WITHOUT bodies — the read `planes`, `events` and the seal's tenant check
  // all start from. `header` says which row is the trajectory's own, because that row decides the workspace.
  // ⚠️ THE TENANT IS A ROW FILTER, NOT ONLY A HEADER CHECK (arch-review 122). `run_id` is the PRIMARY KEY of
  // `everdict_trajectories` and `(run_id, emitter)` of the segments — neither carries the workspace — and this
  // read used to select `WHERE run_id = $1` alone, check the HEADER's tenant, and then return every row it
  // found. The seal refuses a foreign tenant's append (`primary.tenant !== input.tenant`), so no foreign
  // segment exists today and nothing was leaking; the isolation simply lived in the WRITE path while the read
  // trusted it. A backfill, a migration or a second writer would end that silently, and the same rows feed
  // retention. A workspace filter costs one predicate and does not depend on anyone else's guard.
  private async planeRows(tenant: string, runId: string): Promise<PlaneRow[]> {
    const res = await this.client.query<PlaneRow>(
      `SELECT COALESCE(emitter, source) AS emitter, source, event_count, t0, sealed_at, body_format, attempt_id,
              body_split, batch, tenant, true AS header
         FROM everdict_trajectories WHERE run_id = $1 AND tenant = $2
       UNION ALL
       SELECT COALESCE(emitter, source) AS emitter, source, event_count, t0, sealed_at, body_format, attempt_id,
              body_split, batch, tenant, false AS header
         FROM everdict_trajectory_segments WHERE run_id = $1 AND tenant = $2
       ORDER BY header DESC, sealed_at ASC, emitter ASC`,
      [runId, tenant],
    );
    return res.rows;
  }

  private async primary(runId: string): Promise<PrimaryRow | undefined> {
    const res = await this.client.query<PrimaryRow>(
      `SELECT run_id, tenant, source, emitter, event_count, segment_event_count, t0, sealed_at, owner, kind, label, preview
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
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.label ? { label: row.label } : {}),
    ...(row.preview ? { preview: row.preview } : {}),
  };
}
