import type { HandoffCheckpointStore, OutboxEvent } from "@everdict/application-control";
import { type HandoffCheckpointRecord, HandoffCheckpointRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { assertInsertArity, insertPlaceholders } from "../insert-columns.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";

// Handoff checkpoints (ownership protocol O6) — same contract in-memory and on Postgres. Append-only by
// design: the port offers no update and no delete, so a predecessor cannot rewrite the evidence its successor
// already acted on. Ordered newest first, which is the order a successor asks in ("how did this stop?").

export class InMemoryHandoffCheckpointStore implements HandoffCheckpointStore {
  private readonly byId = new Map<string, HandoffCheckpointRecord>();
  private readonly events: OutboxEvent[] = [];

  async create(record: HandoffCheckpointRecord, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<HandoffCheckpointRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined; // another workspace's reads as nonexistent
  }

  async list(tenant: string, options?: { envelopeId?: string; limit?: number }): Promise<HandoffCheckpointRecord[]> {
    const rows = [...this.byId.values()]
      .filter(
        (record) =>
          record.tenant === tenant && (options?.envelopeId === undefined || record.envelopeId === options.envelopeId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return rows.slice(0, options?.limit ?? 200);
  }
}

interface CheckpointRow {
  id: string;
  tenant: string;
  envelope_id: string | null;
  role: string | null;
  goal: string;
  created_by: string;
  created_at: string | Date;
  body: unknown;
}

const iso = (value: string | Date): string => (typeof value === "string" ? value : value.toISOString());

// The body carries the whole contract (facts, hypotheses, actions, plans); the columns beside it are only what
// a query filters or orders on. Splitting a checkpoint's nested arrays into tables would buy nothing — nothing
// reads a checkpoint's hypotheses without reading the checkpoint.
function rowToRecord(row: CheckpointRow): HandoffCheckpointRecord {
  const body = typeof row.body === "string" ? JSON.parse(row.body) : row.body;
  return HandoffCheckpointRecordSchema.parse({
    ...(body as Record<string, unknown>),
    id: row.id,
    tenant: row.tenant,
    goal: row.goal,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  });
}

const CHECKPOINT_COLUMNS = "(id, tenant, envelope_id, role, goal, created_by, created_at, body)";
const CHECKPOINT_VALUES = insertPlaceholders(CHECKPOINT_COLUMNS);

export class PgHandoffCheckpointStore implements HandoffCheckpointStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: HandoffCheckpointRecord, events?: OutboxEvent[]): Promise<void> {
    const params: unknown[] = [
      record.id,
      record.tenant,
      record.envelopeId ?? null,
      record.role ?? null,
      record.goal,
      record.createdBy,
      record.createdAt,
      JSON.stringify(record),
    ];
    assertInsertArity("handoff-checkpoint-store.create", CHECKPOINT_COLUMNS, params);
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, params.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_handoff_checkpoints ${CHECKPOINT_COLUMNS} VALUES ${CHECKPOINT_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...params, ...ev.params],
      );
      return;
    }
    await this.client.query(
      `INSERT INTO everdict_handoff_checkpoints ${CHECKPOINT_COLUMNS} VALUES ${CHECKPOINT_VALUES}`,
      params,
    );
  }

  async get(tenant: string, id: string): Promise<HandoffCheckpointRecord | undefined> {
    const { rows } = await this.client.query<CheckpointRow>(
      "SELECT * FROM everdict_handoff_checkpoints WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string, options?: { envelopeId?: string; limit?: number }): Promise<HandoffCheckpointRecord[]> {
    const conds = ["tenant = $1"];
    const params: unknown[] = [tenant];
    let i = 2;
    if (options?.envelopeId !== undefined) {
      conds.push(`envelope_id = $${i++}`);
      params.push(options.envelopeId);
    }
    params.push(options?.limit ?? 200);
    const { rows } = await this.client.query<CheckpointRow>(
      `SELECT * FROM everdict_handoff_checkpoints WHERE ${conds.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT $${i}`,
      params,
    );
    return rows.map(rowToRecord);
  }
}
