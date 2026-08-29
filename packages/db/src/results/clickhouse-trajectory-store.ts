import {
  MAX_LEGACY_BODY_BYTES,
  type SealInput,
  type SealedTrajectory,
  type TrajectoryEventsResult,
  type TrajectoryListResult,
  type TrajectoryMeta,
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
  serializedBytes,
} from "@everdict/application-control";
import { RunUsageSummarySchema, UpstreamError } from "@everdict/contracts";
import type { SpanBatchFacts } from "@everdict/domain";
import { bodyOf, formatOf, pageBodyOf } from "./trajectory-body.js";
import { type SizedItem, planeFor, sizedItems } from "./trajectory-store.js";

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
//   That clock is BEST-EFFORT and says so — the stamp is each writer's own, and skew between replicas is
//   ordinary. A caller holding the identity a Postgres receipt made canonical asks by it instead
//   (`get(tenant, runId, { attemptId })`), and the store answers from THAT attempt's row; deciding
//   canonicality is Postgres's job, and this store's job is to hold the evidence and hand back the piece it
//   was asked for.
//
// The multi-plane rung needs no new table here — a segment IS a row, keyed by (run_id, emitter). The row
// that sealed first is the trajectory's header; the rest are its other planes.
// ── THE DDL NAMES THE SAME TABLE THE READS DO ────────────────────────────────────────────────────────
//
// Every read and write qualifies the table with the configured database (`<db>.everdict_trajectories`), but
// the schema statements used to be UNQUALIFIED — so on a deployment configured with a database of its own,
// `ensureSchema` created the table in whatever the connection's default database is (ClickHouse: `default`)
// and every subsequent statement addressed a table that did not exist. Boot reported success; the first seal
// failed with UNKNOWN_TABLE, in a store whose whole job is holding evidence.
//
// The database itself is created too. An operator who sets `EVERDICT_CLICKHOUSE_DATABASE` has NAMED the
// database; requiring them to also have created it by hand is a second, undocumented step whose omission
// looks exactly like the bug above.
// ── ONE DESCRIPTOR, BOTH STATEMENTS (arch-review 52, wave 7) ─────────────────────────────────────────
//
// The CREATE and the additive ALTERs were two hand-kept lists, so a fresh install and an upgraded one ran
// DIFFERENT schemas: `attempt_id` shipped in the CREATE and in every read query but was left out of the ALTER
// set, and each deployment that already held evidence failed every `get` with UNKNOWN_IDENTIFIER — after a
// boot that reported success. The drift was fixed by hand once; this removes the way to make it.
//
// A column is declared HERE, once. `schemaSql` builds the CREATE from the list and `ensureSchema` ALTERs the
// same list, so a column cannot exist in one statement and be missing from the other. Every column is
// ALTERed, including the base ones — `ADD COLUMN IF NOT EXISTS` is a no-op on a table that already has it,
// and a handful of no-op DDL statements at boot is cheaper than a rule nobody can check.
interface ColumnSpec {
  name: string;
  // The ClickHouse type, spelled as ClickHouse spells it (String · UInt32 · Nullable(…)). This descriptor IS
  // the DDL rather than a mapping onto it, so a type nobody anticipated needs no new vocabulary here.
  type: string;
  // The DEFAULT expression, when the column has one. Every column added after the first release needs one:
  // ClickHouse fills it for the rows that predate the column, and what that value MEANS to a reader is
  // documented beside the column rather than inferred at each read.
  default?: string;
}

const TRAJECTORY_COLUMNS: readonly ColumnSpec[] = [
  { name: "run_id", type: "String" },
  { name: "tenant", type: "String" },
  { name: "source", type: "String" },
  // The plane this row is (the multi-plane rung). '' = a row from before planes existed; it reads as its
  // arrival channel.
  { name: "emitter", type: "String", default: "''" },
  { name: "event_count", type: "UInt32" },
  { name: "body", type: "String" },
  { name: "t0", type: "String", default: "''" },
  { name: "sealed_at", type: "String" },
  // Whose evidence a trajectory is (mig 0116's rung-2 twin). '' = the workspace's. No backfill here: unlike
  // Postgres this store has no run ledger beside it to read an owner from, and it is opt-in + new.
  { name: "owner", type: "String", default: "''" },
  // What the body holds (N6's rung-2 twin of mig 0118). '' reads as 'events' — which is what every row
  // written before spans became the record actually is. No backfill: sealed evidence is not rewritten.
  { name: "body_format", type: "String", default: "''" },
  // What a piece of evidence IS, and what to call it on a browse row (mig 0124's rung-2 twin). '' = evidence
  // that arrived with no run to name it. No backfill, for the same reason the owner column has none: this
  // store has no run ledger beside it to read from.
  { name: "kind", type: "String", default: "''" },
  { name: "label", type: "String", default: "''" },
  // The line naming what the evidence was ASKED to do (mig 0168's rung-2 twin). '' = a body with no phrase
  // to quote. No backfill, for the reason the Postgres migration gives: the value lives inside the body.
  { name: "preview", type: "String", default: "''" },
  // WHICH physical attempt sealed it (mig 0176's rung-2 twin). '' = the producer did not say — never
  // agreement with whatever attempt a reader has in hand. No backfill: sealed evidence is not rewritten.
  { name: "attempt_id", type: "String", default: "''" },
  // This plane's economics, derived at seal from the body being written (mig 0199's rung-2 twin) — JSON text,
  // '' = not derived. No backfill: '' reads as UNKNOWN, never as zero, because a row whose cost nobody
  // computed is not a row that cost nothing and this number ends up on an invoice.
  { name: "usage", type: "String", default: "''" },
  // Whether this plane's events live in the events table rather than in `body` (mig 0200's rung-2 twin).
  // 0 on every row written before the split, which is what those rows ARE — never inferred from "does the
  // events table have rows", which is a sniff, costs a query, and answers wrong for a plane that legitimately
  // sealed nothing.
  { name: "body_split", type: "UInt8", default: "0" },
  // What a PAGE of a spans plane needs to project like the whole one — JSON text, '' = none (an events
  // plane, or a row from before the split). See SpanBatchFacts: without it a page's relative `t` restarts at
  // every boundary and the page holding an aggregate span double-counts its tokens.
  { name: "batch", type: "String", default: "''" },
];

// ── ONE ROW PER EVENT (mig 0200's rung-2 twin) ───────────────────────────────────────────────────────
//
// The reason this rung exists at all is scale, and it inherited the defect anyway: a plane was one `body`
// String, `argMin(body, sealed_at)` aggregated it server-side, and `res.text()` buffered the whole response
// into one JS string before parsing it twice. Same unit as Postgres, one tier down.
//
// A separate table ordered by (run_id, emitter, seq) makes the window a range scan, which is what this engine
// is for. `bytes` is the writer's measurement, so a page can be budgeted without reading the bodies it is
// deciding about.
const EVENT_COLUMNS: readonly ColumnSpec[] = [
  { name: "run_id", type: "String" },
  { name: "emitter", type: "String" },
  { name: "seq", type: "UInt32" },
  { name: "body", type: "String" },
  { name: "bytes", type: "UInt32" },
  // The seal's own stamp, so a duplicate seal (this engine has no unique key — see the header) resolves to
  // the FIRST writer per (run_id, emitter, seq), exactly as the plane rows do.
  { name: "sealed_at", type: "String" },
];
const EVENT_ORDER_BY = "(run_id, emitter, seq)";

// Skipping indexes: a data-skipping index is part of the CREATE and has no ADD COLUMN twin, so it is listed
// beside the columns rather than inside them (`ALTER … ADD INDEX` on an existing table only affects new
// parts, which is why upgrading one is a deliberate act and not boot DDL).
const TRAJECTORY_INDEXES: readonly string[] = ["INDEX idx_run run_id TYPE bloom_filter GRANULARITY 4"];
const TRAJECTORY_ORDER_BY = "(tenant, sealed_at, run_id)";

const columnDdl = (column: ColumnSpec): string =>
  `${column.name} ${column.type}${column.default !== undefined ? ` DEFAULT ${column.default}` : ""}`;

const schemaSql = (table: string): string =>
  `CREATE TABLE IF NOT EXISTS ${table} (\n  ${[...TRAJECTORY_COLUMNS.map(columnDdl), ...TRAJECTORY_INDEXES].join(
    ",\n  ",
  )}\n) ENGINE = MergeTree ORDER BY ${TRAJECTORY_ORDER_BY}`;

const eventsSchemaSql = (table: string): string =>
  `CREATE TABLE IF NOT EXISTS ${table} (\n  ${EVENT_COLUMNS.map(columnDdl).join(
    ",\n  ",
  )}\n) ENGINE = MergeTree ORDER BY ${EVENT_ORDER_BY}`;

// Additive DDL for installs created before a column existed — idempotent, like the CREATE above, and derived
// from the same descriptor so the two can never disagree.
const alterSql = (table: string, column: ColumnSpec): string =>
  `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${columnDdl(column)}`;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

// One plane as the BODY-FREE read returns it (see `planes`). The *_first aliases are not decoration: a
// ClickHouse alias shadows its column EVERYWHERE in the SELECT, so `argMin(tenant, …) AS tenant` would make
// every later reference resolve to the aggregate itself.
interface PlaneRow {
  run_id: string;
  emitter: string;
  tenant_first: string;
  source_first: string;
  event_count_first: number | string;
  owner_first: string;
  kind_first: string;
  label_first: string;
  preview_first: string;
  t0_first: string;
  usage_first: string;
  body_split_first: number;
  batch_first: string;
  body_format_first: string;
  attempt_id_first: string;
  sealed_at_first: string;
}

// Rows written before the multi-plane rung carry no emitter — they read as their arrival channel, exactly as
// `get` maps them. Written once so a plane cannot be named one way by the read and another by the seal.
function planeEmitter(row: PlaneRow): string {
  return row.emitter === "" ? row.source_first : row.emitter;
}

// One plane's header, from the body-free row. The same mapping the Postgres twin does, so the two rungs
// cannot describe a plane differently.
function planeOf(row: PlaneRow): TrajectorySegment {
  return {
    emitter: planeEmitter(row),
    source: row.source_first as TrajectoryMeta["source"],
    eventCount: Number(row.event_count_first),
    ...(row.t0_first !== undefined && row.t0_first !== "" ? { t0: row.t0_first } : {}),
    sealedAt: row.sealed_at_first,
    format: formatOf(row.body_format_first),
    ...(row.attempt_id_first ? { attemptId: row.attempt_id_first } : {}),
    ...(row.batch_first ? { batch: JSON.parse(row.batch_first) as SpanBatchFacts } : {}),
  };
}

// The header a body-free read can answer, in the SHAPE `get` answers it — deliberately including `get`'s
// omission of kind/label/preview, so swapping the seal's source of truth changes what it returns by nothing.
function metaOfPlanes(runId: string, tenant: string, header: PlaneRow, planes: PlaneRow[]): TrajectoryMeta {
  return {
    runId,
    tenant,
    source: header.source_first as TrajectoryMeta["source"],
    eventCount: planes.reduce((sum, p) => sum + Number(p.event_count_first), 0),
    sealedAt: header.sealed_at_first,
    ...(header.owner_first ? { owner: header.owner_first } : {}),
  };
}

interface RunRow {
  run_id: string;
  tenant_run: string;
  source_run: string;
  event_count_run: number | string;
  sealed_at_run: string;
  owner_run: string;
  kind_run: string;
  label_run: string;
  preview_run: string;
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
    ...(row.preview_run ? { preview: row.preview_run } : {}),
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
    const table = this.table();
    await this.command(`CREATE DATABASE IF NOT EXISTS ${this.database()}`, {});
    await this.command(schemaSql(table), {});
    for (const column of TRAJECTORY_COLUMNS) await this.command(alterSql(table, column), {});
    // The events table gets the same treatment for the same reason: one descriptor drives both the CREATE and
    // the additive ALTERs, so a fresh install and an upgraded one cannot end up running different schemas.
    const events = this.eventsTable();
    await this.command(eventsSchemaSql(events), {});
    for (const column of EVENT_COLUMNS) await this.command(alterSql(events, column), {});
  }

  async seal(input: SealInput): Promise<TrajectoryMeta & { created: boolean }> {
    const emitter = input.emitter ?? defaultEmitter(input.source);
    const sealedAt = new Date().toISOString();
    const body = sealBody(input);
    const count = body.spans?.length ?? body.events.length;
    // Body-free: this call decides a set membership and a tenant, and both are answerable without a single
    // event travelling. See `planes`.
    const planes = await this.planeRows(input.runId);
    const headerPlane = planes[0];
    const existing =
      headerPlane !== undefined && headerPlane.tenant_first === input.tenant
        ? { planes, meta: metaOfPlanes(input.runId, input.tenant, headerPlane, planes) }
        : undefined;
    const fallback = {
      runId: input.runId,
      tenant: input.tenant,
      source: input.source,
      eventCount: count,
      sealedAt,
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.preview !== undefined ? { preview: input.preview } : {}),
    };
    if (existing) {
      // First seal per emitter wins — evidence is never rewritten; a new emitter is a new plane.
      if (existing.planes.some((p) => planeEmitter(p) === emitter)) return { ...existing.meta, created: false };
    } else if (headerPlane !== undefined) {
      // Rows exist under this id but the header is another workspace's: a cross-tenant read answers
      // undefined, so never write a second tenant's row under the same run. The one read above already
      // established this — the separate existence probe it used to need is gone.
      return { ...fallback, created: false };
    }
    const items = sizedItems(body);
    const row = {
      run_id: input.runId,
      tenant: input.tenant,
      source: input.source,
      emitter,
      event_count: count,
      // EMPTY on a split plane — the events are rows in the events table now (mig 0200's rung-2 twin). Kept
      // rather than dropped so a replica on the previous release reads "renders empty" instead of failing.
      body: "[]",
      body_format: body.format,
      t0: input.t0 ?? "",
      sealed_at: sealedAt,
      owner: input.owner ?? "",
      kind: input.kind ?? "",
      label: input.label ?? "",
      preview: input.preview ?? "",
      attempt_id: input.attemptId ?? "",
      // Derived from the body in the row beside it, by the one function every impl seals through — '' when
      // the body would not project, which the read reports as unknown rather than as zero.
      usage: body.usage !== undefined ? JSON.stringify(body.usage) : "",
      body_split: 1,
      // What a PAGE of this plane needs to project like the whole one — '' for an events plane.
      batch: body.batch !== undefined ? JSON.stringify(body.batch) : "",
    };
    // The events FIRST, then the plane row that claims them. A crash between the two leaves event rows no
    // plane points at — invisible, and swept with the run by retention — where the other order would leave a
    // plane claiming `body_split` over rows that do not exist yet, which every read would serve as an empty
    // trajectory. Neither is a transaction (this engine has none); the order decides which failure you get.
    await this.writeEvents(input.runId, emitter, sealedAt, items);
    await this.command(`INSERT INTO ${this.table()} FORMAT JSONEachRow`, {}, JSON.stringify(row));
    if (!existing) return { ...fallback, created: true };
    return {
      ...existing.meta,
      eventCount: existing.meta.eventCount + count,
      created: true,
    };
  }

  async planes(tenant: string, runId: string, opts?: { attemptId: string }): Promise<SealedTrajectory | undefined> {
    const rows = await this.planeRows(runId, opts?.attemptId);
    const header = rows[0];
    if (!header || header.tenant_first !== tenant) return undefined;
    const segments = rows.map(planeOf);
    const execution = executionSegment(segments);
    // A plane declaring a DIFFERENT attempt is dropped in SQL (see `planeRows`), so what survives is either
    // this attempt's evidence or evidence nobody attributed — and the count says how much of the second kind
    // came back, exactly as the Postgres twin's `trajectoryForAttempt` does.
    const unattributed = opts === undefined ? 0 : segments.filter((s) => s.attemptId === undefined).length;
    return {
      meta: {
        runId,
        tenant,
        source: header.source_first as TrajectoryMeta["source"],
        eventCount: segments.reduce((sum, s) => sum + s.eventCount, 0),
        sealedAt: header.sealed_at_first,
        ...(header.owner_first ? { owner: header.owner_first } : {}),
      },
      ...(execution !== undefined ? { executionEmitter: execution.emitter } : {}),
      ...(unattributed > 0 ? { unattributedSegments: unattributed } : {}),
      segments,
    };
  }

  async events(tenant: string, runId: string, window: TrajectoryWindow): Promise<TrajectoryEventsResult> {
    const rows = await this.planeRows(runId, window.attemptId);
    const header = rows[0];
    if (!header || header.tenant_first !== tenant) return { kind: "absent" };
    const row = planeFor(
      rows.map((r) => ({ row: r, emitter: planeEmitter(r) })),
      window.emitter,
    );
    if (row === undefined) return { kind: "absent" };
    const plane = planeOf(row.row);
    const { limit, maxBytes, after } = clampWindow(window);
    const params = { runId, emitter: row.emitter };

    if (row.row.body_split_first === 0) {
      // ── A PLANE SEALED BEFORE THE SPLIT ───────────────────────────────────────────────────────────
      //
      // One String, and no window of it costs less than all of it. `length(body)` answers "how big" without
      // shipping it, so the refusal is decided server-side; above the ceiling the honest answer names the
      // size and the repair rather than trying and dying.
      const sized = await this.select<{ stored: number | string }>(
        `SELECT argMin(length(body), sealed_at) AS stored FROM ${this.table()}
          WHERE run_id = {runId:String} AND (emitter = {emitter:String} OR (emitter = '' AND source = {emitter:String}))
          GROUP BY emitter`,
        params,
      );
      const storedBytes = Number(sized[0]?.stored ?? 0);
      if (storedBytes > MAX_LEGACY_BODY_BYTES)
        return { kind: "too_large", storedBytes, limitBytes: MAX_LEGACY_BODY_BYTES, emitter: plane.emitter };
      const read = await this.select<{ body_first: string }>(
        `SELECT argMin(body, sealed_at) AS body_first FROM ${this.table()}
          WHERE run_id = {runId:String} AND (emitter = {emitter:String} OR (emitter = '' AND source = {emitter:String}))
          GROUP BY emitter`,
        params,
      );
      const whole = bodyOf(plane.format, JSON.parse(read[0]?.body_first ?? "[]"));
      const units: unknown[] = whole.spans ?? whole.events;
      const legacy = pageOf(units, after, limit, maxBytes, serializedBytes);
      return {
        kind: "page",
        page: {
          emitter: plane.emitter,
          format: plane.format,
          ...pageBodyOf(plane.format, legacy.slice, plane.batch),
          ...(legacy.nextAfter !== undefined ? { nextAfter: legacy.nextAfter } : {}),
          ...(plane.batch !== undefined ? { batch: plane.batch } : {}),
          eventCount: plane.eventCount,
        },
      };
    }

    // ── THE SPLIT PLANE, IN TWO STEPS ───────────────────────────────────────────────────────────────
    //
    // Sizes first, bodies second, and both bounded by a contiguous seq RANGE rather than by a LIMIT after a
    // GROUP BY — this engine would otherwise aggregate the whole plane before the limit could shorten it,
    // which is the defect one tier up. seq is contiguous 1..eventCount (the seal writes it that way), so
    // `after < seq <= after + limit` IS the page's candidate set.
    //
    // The `argMin(…, sealed_at)` is the same first-write-wins resolution the plane rows use: MergeTree has no
    // unique key, so a duplicate seal is a duplicate ROW and every read has to collapse it the same way.
    const sizes = await this.select<{ seq: number | string; bytes_first: number | string }>(
      `SELECT seq, argMin(bytes, sealed_at) AS bytes_first FROM ${this.eventsTable()}
        WHERE run_id = {runId:String} AND emitter = {emitter:String}
          AND seq > {after:UInt32} AND seq <= {upper:UInt32}
        GROUP BY seq ORDER BY seq`,
      { ...params, after: String(after), upper: String(after + limit) },
    );
    const budgeted = pageOf(sizes, 0, limit, maxBytes, (s) => Number(s.bytes_first));
    const cut = budgeted.slice[budgeted.slice.length - 1]?.seq;
    if (cut === undefined)
      return {
        kind: "page",
        page: { emitter: plane.emitter, format: plane.format, events: [], eventCount: plane.eventCount },
      };
    const bodies = await this.select<{ seq: number | string; body_first: string }>(
      `SELECT seq, argMin(body, sealed_at) AS body_first FROM ${this.eventsTable()}
        WHERE run_id = {runId:String} AND emitter = {emitter:String}
          AND seq > {after:UInt32} AND seq <= {cut:UInt32}
        GROUP BY seq ORDER BY seq`,
      { ...params, after: String(after), cut: String(Number(cut)) },
    );
    const lastSeq = Number(cut);
    return {
      kind: "page",
      page: {
        emitter: plane.emitter,
        format: plane.format,
        ...pageBodyOf(
          plane.format,
          bodies.map((b) => JSON.parse(b.body_first)),
          plane.batch,
        ),
        ...(lastSeq < plane.eventCount ? { nextAfter: lastSeq } : {}),
        ...(plane.batch !== undefined ? { batch: plane.batch } : {}),
        eventCount: plane.eventCount,
      },
    };
  }

  // One row per event, seq 1..N in PAGING order, as a single JSONEachRow batch — a per-event round trip would
  // make sealing a long-horizon run O(N) HTTP requests.
  private async writeEvents(runId: string, emitter: string, sealedAt: string, items: SizedItem[]): Promise<void> {
    if (items.length === 0) return;
    const body = items
      .map((item, index) =>
        JSON.stringify({
          run_id: runId,
          emitter,
          seq: index + 1,
          body: JSON.stringify(item.body),
          bytes: item.bytes,
          sealed_at: sealedAt,
        }),
      )
      .join("\n");
    await this.command(`INSERT INTO ${this.eventsTable()} FORMAT JSONEachRow`, {}, body);
  }

  // The Postgres twin, over the body-free plane read: emitters and summaries, no `argMin(body, …)` anywhere
  // in the statement. That absence IS the feature — see `TrajectoryUsage`.
  async usage(tenant: string, runId: string): Promise<TrajectoryUsage> {
    const planes = await this.planeRows(runId);
    const header = planes[0];
    if (!header || header.tenant_first !== tenant) return { kind: "absent" };
    // The same plane `get().events` would have come from, resolved by the shared predicate rather than by a
    // second spelling of the order (L3).
    const emitter = executionEmitterOf(planes.map(planeEmitter));
    const plane = planes.find((p) => planeEmitter(p) === emitter);
    if (!plane || plane.usage_first === "") return { kind: "unknown", reason: "sealed_before_derivation" };
    return { kind: "derived", usage: RunUsageSummarySchema.parse(JSON.parse(plane.usage_first)) };
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
              argMin(label_first, sealed_at_first) AS label_run,
              argMin(preview_first, sealed_at_first) AS preview_run
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

  // ── WHAT RETENTION IS ABOUT TO DESTROY THE ONLY POINTER TO (arch-review 120) ─────────────────────
  //
  // The rung-2 twin of the Postgres reader. A body here is JSON TEXT rather than jsonb, so the refs are
  // matched over the text — and the pattern anchors on the OPENING QUOTE for the reason the Postgres twin
  // matches whole values: `artifact://[^"]+` alone also matches a ref MENTIONED inside an agent's own
  // output ("I saved it, see artifact://k9"), and retention deletes what this returns. One run quoting
  // another run's ref would have destroyed that run's evidence. The three impls answer the same question
  // now: a complete string value that STARTS WITH the scheme.
  async payloadRefsOlderThan(cutoffIso: string, limit: number): Promise<string[]> {
    const runs = this.expiredRunsSql();
    const rows = await this.select<{ ref: string }>(
      `SELECT DISTINCT ref FROM (
         SELECT arrayJoin(extractAll(body, '"(artifact://[^"]*)"')) AS ref
           FROM ${this.eventsTable()} WHERE run_id IN (${runs})
         UNION ALL
         SELECT arrayJoin(extractAll(body, '"(artifact://[^"]*)"')) AS ref
           FROM ${this.table()} WHERE run_id IN (${runs})
       ) LIMIT {limit:UInt32}`,
      { cutoff: cutoffIso, limit: String(limit) },
    );
    return rows.map((r) => r.ref);
  }

  async deleteOlderThan(cutoffIso: string): Promise<number> {
    // Cutoff applies to the TRAJECTORY (its earliest seal), never to a single plane — a later segment must
    // not survive its own run, and an early one must not drag a live run's planes away.
    const counted = await this.select<{ trajectories: number | string }>(
      `SELECT count() AS trajectories FROM (${this.expiredRunsSql()})`,
      { cutoff: cutoffIso },
    );
    const removed = Number(counted[0]?.trajectories ?? 0);
    if (removed > 0) {
      // The events FIRST, then the planes that name them. This engine has no foreign key and no transaction,
      // so retention has to sweep both by hand — and in this order, because the second statement is what
      // computes `expiredRunsSql`. Deleting the planes first would leave the events unreachable AND
      // un-expirable: nothing would answer "which runs are past the cutoff" for them ever again.
      await this.command(`DELETE FROM ${this.eventsTable()} WHERE run_id IN (${this.expiredRunsSql()})`, {
        cutoff: cutoffIso,
      });
      await this.command(`DELETE FROM ${this.table()} WHERE run_id IN (${this.expiredRunsSql()})`, {
        cutoff: cutoffIso,
      });
    }
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
              argMin(preview, sealed_at) AS preview_first,
              argMin(t0, sealed_at) AS t0_first,
              argMin(usage, sealed_at) AS usage_first,
              argMin(body_split, sealed_at) AS body_split_first,
              argMin(batch, sealed_at) AS batch_first,
              argMin(body_format, sealed_at) AS body_format_first,
              argMin(attempt_id, sealed_at) AS attempt_id_first,
              min(sealed_at) AS sealed_at_first
       FROM ${this.table()} WHERE ${where} GROUP BY run_id, emitter`;
  }

  // The identity-ranked twin of `perEmitterSql`. Same columns, same *_first aliasing rule; the ORDER inside
  // every argMin is `(attempt_rank, sealed_at)` instead of `sealed_at` alone, and rank 2 never survives.
  private perEmitterRankedSql(): string {
    const cols = [
      "tenant",
      "source",
      "event_count",
      "owner",
      "kind",
      "label",
      "preview",
      "t0",
      "usage",
      "body_split",
      "batch",
      "body_format",
      "attempt_id",
    ];
    return `SELECT run_id, emitter,
              ${cols.map((c) => `argMin(${c}, (attempt_rank, sealed_at)) AS ${c}_first`).join(",\n              ")},
              argMin(sealed_at, (attempt_rank, sealed_at)) AS sealed_at_first
       FROM (SELECT *, if(attempt_id = {attemptId:String}, 0, if(attempt_id = '', 1, 2)) AS attempt_rank
             FROM ${this.table()} WHERE run_id = {runId:String})
       GROUP BY run_id, emitter
       HAVING min(attempt_rank) < 2`;
  }

  // The planes of ONE trajectory without their bodies — emitters, counters, and the summaries derived at
  // seal. `seal` used to answer "has this emitter sealed already?" by calling `get`, which aggregates
  // `argMin(body, sealed_at)` over every plane: appending one segment to a long-horizon run re-read the
  // ENTIRE trajectory, first into ClickHouse's memory and then into ours, to decide a set membership. Two
  // callers now share one body-free read, and it answers the cross-tenant probe as well — so the extra
  // `SELECT run_id … LIMIT 1` that used to follow it is gone with the read that needed it.
  // ── THE EXACT-IDENTITY READ (arch-review 52, wave 7), NOW ON THE BODY-FREE PATH ─────────────────
  //
  // Without an attempt the winner per emitter is decided by the CLOCK — best-effort by construction, since
  // the stamp is each writer's own. With one, the tie-break is the IDENTITY first and the clock only within
  // it (`attempt_rank` is `segmentDeclaresAttempt`, stated in SQL because here the duplicates are rows and
  // they collapse before any caller could filter them):
  //   0 — the plane declares the attempt asked for            → this is the evidence
  //   1 — the plane declares none ('' — the producer did not say, which is not disagreement)
  //   2 — the plane declares a DIFFERENT attempt              → another execution's bytes
  // and rank 2 is DROPPED by the HAVING rather than served, so an emitter whose only rows belong to other
  // attempts contributes nothing and a run with no agreeing plane reads as absent.
  private planeRows(runId: string, attemptId?: string): Promise<PlaneRow[]> {
    if (attemptId !== undefined)
      return this.select<PlaneRow>(
        `SELECT run_id, emitter, tenant_first, source_first, event_count_first, owner_first, kind_first,
                label_first, preview_first, t0_first, usage_first, body_split_first, batch_first,
                body_format_first, attempt_id_first, sealed_at_first
         FROM (${this.perEmitterRankedSql()})
         ORDER BY sealed_at_first ASC, emitter ASC`,
        { runId, attemptId },
      );
    return this.planeRowsByClock(runId);
  }

  private planeRowsByClock(runId: string): Promise<PlaneRow[]> {
    return this.select<PlaneRow>(
      `SELECT run_id, emitter, tenant_first, source_first, event_count_first, owner_first, kind_first,
              label_first, preview_first, t0_first, usage_first, body_split_first, batch_first,
              body_format_first, attempt_id_first, sealed_at_first
       FROM (${this.perEmitterSql("run_id = {runId:String}")})
       ORDER BY sealed_at_first ASC, emitter ASC`,
      { runId },
    );
  }

  private expiredRunsSql(): string {
    return `SELECT run_id FROM ${this.table()} GROUP BY run_id HAVING min(sealed_at) < {cutoff:String}`;
  }

  private table(): string {
    return `${this.database()}.everdict_trajectories`;
  }

  private eventsTable(): string {
    return `${this.database()}.everdict_trajectory_events`;
  }

  // A database name reaches SQL as an IDENTIFIER — it cannot ride the `param_` binding every value uses. So
  // it is checked instead of trusted: the operator's env var is the one string in this store that becomes SQL
  // text, and a name that is not a plain identifier is refused at construction rather than concatenated.
  private database(): string {
    const name = this.opts.database ?? "default";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { store: "clickhouse", database: name },
        `ClickHouse database name "${name}" is not a plain identifier — set EVERDICT_CLICKHOUSE_DATABASE to [A-Za-z_][A-Za-z0-9_]*`,
      );
    return name;
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
