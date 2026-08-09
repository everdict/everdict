import type { OutboxEvent, VerificationDecisionStore } from "@everdict/application-control";
import { type VerificationDecision, VerificationDecisionSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";

// The verification ledger (mig 0151) — same contract in-memory and on Postgres. Append-only like the
// checkpoint store beside it, and for a stronger reason: a checkpoint is history a successor reads, a
// verification is a JUDGMENT someone stood behind. There is no update path, so a revised verdict is a second
// record and the sequence stays legible.

export class InMemoryVerificationDecisionStore implements VerificationDecisionStore {
  private readonly byId = new Map<string, VerificationDecision>();
  private readonly events: OutboxEvent[] = [];

  async create(record: VerificationDecision, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<VerificationDecision | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined; // another workspace's reads as nonexistent
  }

  async listForSubject(tenant: string, subject: { type: string; id: string }): Promise<VerificationDecision[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant && r.subject.type === subject.type && r.subject.id === subject.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async list(tenant: string, options?: { limit?: number }): Promise<VerificationDecision[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options?.limit ?? 200);
  }

  emittedEvents(): OutboxEvent[] {
    return [...this.events];
  }
}

interface DecisionRow {
  id: string;
  tenant: string;
  subject_type: string;
  subject_id: string;
  verdict: string;
  created_at: string | Date;
  body: unknown;
}

const iso = (value: string | Date): string => (typeof value === "string" ? value : value.toISOString());

// The body carries the whole contract (evidence refs, both actors, the independence result); the columns
// beside it are only what a query filters or orders on — the same split the checkpoint store uses.
function rowToRecord(row: DecisionRow): VerificationDecision {
  const body = typeof row.body === "string" ? JSON.parse(row.body) : row.body;
  return VerificationDecisionSchema.parse({
    ...(body as Record<string, unknown>),
    id: row.id,
    tenant: row.tenant,
    createdAt: iso(row.created_at),
  });
}

const DECISION_COLUMNS = "(id, tenant, subject_type, subject_id, verdict, created_at, body)";
const DECISION_VALUES = "($1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb)";

export class PgVerificationDecisionStore implements VerificationDecisionStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: VerificationDecision, events?: OutboxEvent[]): Promise<void> {
    const params: unknown[] = [
      record.id,
      record.tenant,
      record.subject.type,
      record.subject.id,
      record.verdict,
      record.createdAt,
      JSON.stringify(record),
    ];
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, params.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_verification_decisions ${DECISION_COLUMNS} VALUES ${DECISION_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...params, ...ev.params],
      );
      return;
    }
    await this.client.query(
      `INSERT INTO everdict_verification_decisions ${DECISION_COLUMNS} VALUES ${DECISION_VALUES}`,
      params,
    );
  }

  async get(tenant: string, id: string): Promise<VerificationDecision | undefined> {
    const { rows } = await this.client.query<DecisionRow>(
      "SELECT * FROM everdict_verification_decisions WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async listForSubject(tenant: string, subject: { type: string; id: string }): Promise<VerificationDecision[]> {
    const { rows } = await this.client.query<DecisionRow>(
      `SELECT * FROM everdict_verification_decisions
       WHERE tenant=$1 AND subject_type=$2 AND subject_id=$3
       ORDER BY created_at DESC, id DESC`,
      [tenant, subject.type, subject.id],
    );
    return rows.map(rowToRecord);
  }

  async list(tenant: string, options?: { limit?: number }): Promise<VerificationDecision[]> {
    const { rows } = await this.client.query<DecisionRow>(
      `SELECT * FROM everdict_verification_decisions WHERE tenant=$1
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [tenant, options?.limit ?? 200],
    );
    return rows.map(rowToRecord);
  }
}
