import type {
  CampaignAppendOutcome,
  CampaignCloseOutcome,
  EvolutionCampaignStore,
  OutboxEvent,
} from "@everdict/application-control";
import {
  type CampaignClose,
  type CampaignRound,
  type CampaignState,
  type EvolutionCampaignRecord,
  EvolutionCampaignRecordSchema,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";

// ── EvolutionCampaignStore impls (docs/architecture/evolution-lineage.md, Track D) ───────────────────
//
// Both twins make the SAME decisions — the append CAS on the round count and the open-only close guard —
// so a unit test over the in-memory store exercises the refusal a production Postgres would give (rule
// `testing`: a guard the in-memory twin does not have is a guard no unit test can see). Facts ride the
// same write via the E0 outbox `events` parameter, exactly as the tracker stores carry theirs.

export class InMemoryEvolutionCampaignStore implements EvolutionCampaignStore {
  private readonly byId = new Map<string, EvolutionCampaignRecord>();
  private readonly events: OutboxEvent[] = [];

  async create(record: EvolutionCampaignRecord, events?: OutboxEvent[]): Promise<void> {
    if (this.byId.has(record.id)) throw new Error(`campaign ${record.id} already exists`);
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<EvolutionCampaignRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined; // another workspace's row reads as nonexistent
  }

  async list(tenant: string): Promise<EvolutionCampaignRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant)
      .sort((a, b) =>
        a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt),
      );
  }

  async appendRound(
    tenant: string,
    id: string,
    round: CampaignRound,
    expectedRounds: number,
    events?: OutboxEvent[],
  ): Promise<CampaignAppendOutcome> {
    const record = await this.get(tenant, id);
    if (!record) return { kind: "absent" };
    if (record.state !== "open") return { kind: "terminal", state: record.state };
    if (record.rounds.length !== expectedRounds)
      return { kind: "conflict", expected: expectedRounds, actual: record.rounds.length };
    const rounds = [...record.rounds, round];
    this.byId.set(id, { ...record, rounds, updatedAt: round.at });
    if (events) this.events.push(...events);
    return { kind: "appended", seq: rounds.length };
  }

  async close(
    tenant: string,
    id: string,
    state: Exclude<CampaignState, "open">,
    close: CampaignClose,
    events?: OutboxEvent[],
  ): Promise<CampaignCloseOutcome> {
    const record = await this.get(tenant, id);
    if (!record) return { kind: "absent" };
    if (record.state !== "open") return { kind: "already", state: record.state };
    this.byId.set(id, { ...record, state, close, updatedAt: close.at });
    if (events) this.events.push(...events);
    return { kind: "closed" };
  }

  // Test/dev inspection of the outbox half — the Pg impl's equivalent is the platform-events table.
  outbox(): OutboxEvent[] {
    return [...this.events];
  }
}

interface CampaignRow {
  id: string;
  tenant: string;
  issue_id: string;
  frame: unknown;
  frame_digest: string;
  rounds: unknown;
  state: string;
  close: unknown;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v);

function rowToRecord(row: CampaignRow): EvolutionCampaignRecord {
  return EvolutionCampaignRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    issueId: row.issue_id,
    frame: row.frame,
    frameDigest: row.frame_digest,
    rounds: row.rounds,
    state: row.state,
    ...(row.close !== null && row.close !== undefined ? { close: row.close } : {}),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

const COLUMNS = "(id, tenant, issue_id, frame, frame_digest, rounds, state, close, created_by, created_at, updated_at)";
const VALUES = "($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8::jsonb, $9, $10::timestamptz, $11::timestamptz)";

export class PgEvolutionCampaignStore implements EvolutionCampaignStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: EvolutionCampaignRecord, events?: OutboxEvent[]): Promise<void> {
    const base = [
      record.id,
      record.tenant,
      record.issueId,
      JSON.stringify(record.frame),
      record.frameDigest,
      JSON.stringify(record.rounds),
      record.state,
      record.close !== undefined ? JSON.stringify(record.close) : null,
      record.createdBy,
      record.createdAt,
      record.updatedAt,
    ];
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_evolution_campaigns ${COLUMNS} VALUES ${VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_evolution_campaigns ${COLUMNS} VALUES ${VALUES}`, base);
  }

  async get(tenant: string, id: string): Promise<EvolutionCampaignRecord | undefined> {
    const { rows } = await this.client.query<CampaignRow>(
      "SELECT * FROM everdict_evolution_campaigns WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string): Promise<EvolutionCampaignRecord[]> {
    const { rows } = await this.client.query<CampaignRow>(
      "SELECT * FROM everdict_evolution_campaigns WHERE tenant=$1 ORDER BY created_at DESC, id DESC",
      [tenant],
    );
    return rows.map(rowToRecord);
  }

  async appendRound(
    tenant: string,
    id: string,
    round: CampaignRound,
    expectedRounds: number,
    events?: OutboxEvent[],
  ): Promise<CampaignAppendOutcome> {
    // One statement: the CAS UPDATE, the outbox insert gated on it, and the landed count read back — the
    // decision consumes the write's answer rather than assuming it (rule `protocol`, conditional writes).
    const base = [tenant, id, JSON.stringify(round), round.at, expectedRounds];
    const ev = events && events.length > 0 ? eventValuesClause(events, base.length + 1) : undefined;
    const { rows } = await this.client.query<{ n: number | string }>(
      `WITH upd AS (
         UPDATE everdict_evolution_campaigns
         SET rounds = rounds || $3::jsonb, updated_at = $4::timestamptz
         WHERE tenant=$1 AND id=$2 AND state='open' AND jsonb_array_length(rounds) = $5
         RETURNING jsonb_array_length(rounds) AS n
       )${
         ev !== undefined
           ? `, ev AS (
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM upd)
       )`
           : ""
       }
       SELECT n FROM upd`,
      [...base, ...(ev?.params ?? [])],
    );
    const n = rows[0]?.n;
    if (n !== undefined) return { kind: "appended", seq: Number(n) };
    // The write refused — read back WHY, so the caller gets a nameable refusal rather than a shrug.
    const { rows: readback } = await this.client.query<{ state: string; n: number | string }>(
      "SELECT state, jsonb_array_length(rounds) AS n FROM everdict_evolution_campaigns WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    const row = readback[0];
    if (row === undefined) return { kind: "absent" };
    if (row.state !== "open") return { kind: "terminal", state: row.state as CampaignState };
    return { kind: "conflict", expected: expectedRounds, actual: Number(row.n) };
  }

  async close(
    tenant: string,
    id: string,
    state: Exclude<CampaignState, "open">,
    close: CampaignClose,
    events?: OutboxEvent[],
  ): Promise<CampaignCloseOutcome> {
    const base = [tenant, id, state, JSON.stringify(close), close.at];
    const ev = events && events.length > 0 ? eventValuesClause(events, base.length + 1) : undefined;
    const { rows } = await this.client.query<{ id: string }>(
      `WITH upd AS (
         UPDATE everdict_evolution_campaigns
         SET state = $3, close = $4::jsonb, updated_at = $5::timestamptz
         WHERE tenant=$1 AND id=$2 AND state='open'
         RETURNING id
       )${
         ev !== undefined
           ? `, ev AS (
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM upd)
       )`
           : ""
       }
       SELECT id FROM upd`,
      [...base, ...(ev?.params ?? [])],
    );
    if (rows[0] !== undefined) return { kind: "closed" };
    const { rows: readback } = await this.client.query<{ state: string }>(
      "SELECT state FROM everdict_evolution_campaigns WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    const row = readback[0];
    if (row === undefined) return { kind: "absent" };
    return { kind: "already", state: row.state as CampaignState };
  }
}
