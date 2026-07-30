import type { SubscriptionStore } from "@everdict/application-control";
import { type SubscriptionRecord, SubscriptionRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// Subscription registry stores (event-plumbing.md E3 §6) — same contract in-memory and on Postgres.
// selector/reaction/governance are jsonb; rows go through SubscriptionRecordSchema at the read boundary.

export class InMemorySubscriptionStore implements SubscriptionStore {
  private readonly byId = new Map<string, SubscriptionRecord>();

  async create(record: SubscriptionRecord): Promise<void> {
    this.byId.set(record.id, record);
  }

  async get(tenant: string, id: string): Promise<SubscriptionRecord | undefined> {
    const r = this.byId.get(id);
    return r && r.tenant === tenant ? r : undefined; // another workspace's row reads as nonexistent
  }

  async list(tenant: string): Promise<SubscriptionRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listEnabled(tenant: string): Promise<SubscriptionRecord[]> {
    return (await this.list(tenant)).filter((r) => r.governance.enabled);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<SubscriptionRecord>,
  ): Promise<SubscriptionRecord | undefined> {
    const r = this.byId.get(id);
    if (!r || r.tenant !== tenant) return undefined;
    const next = { ...r, ...patch, id: r.id, tenant: r.tenant };
    this.byId.set(id, next);
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    const r = this.byId.get(id);
    if (r && r.tenant === tenant) this.byId.delete(id);
  }
}

interface SubscriptionRow {
  id: string;
  tenant: string;
  name: string;
  selector: unknown;
  reaction: unknown;
  governance: unknown;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

function rowToRecord(row: SubscriptionRow): SubscriptionRecord {
  return SubscriptionRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    name: row.name,
    selector: row.selector,
    reaction: row.reaction,
    governance: row.governance,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class PgSubscriptionStore implements SubscriptionStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: SubscriptionRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_subscriptions (id, tenant, name, selector, reaction, governance, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        record.id,
        record.tenant,
        record.name,
        JSON.stringify(record.selector),
        JSON.stringify(record.reaction),
        JSON.stringify(record.governance),
        record.createdBy,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async get(tenant: string, id: string): Promise<SubscriptionRecord | undefined> {
    const { rows } = await this.client.query<SubscriptionRow>(
      "SELECT * FROM everdict_subscriptions WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string): Promise<SubscriptionRecord[]> {
    const { rows } = await this.client.query<SubscriptionRow>(
      "SELECT * FROM everdict_subscriptions WHERE tenant=$1 ORDER BY created_at DESC",
      [tenant],
    );
    return rows.map(rowToRecord);
  }

  async listEnabled(tenant: string): Promise<SubscriptionRecord[]> {
    const { rows } = await this.client.query<SubscriptionRow>(
      `SELECT * FROM everdict_subscriptions
       WHERE tenant=$1 AND (governance->>'enabled') = 'true'
       ORDER BY created_at DESC`,
      [tenant],
    );
    return rows.map(rowToRecord);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<SubscriptionRecord>,
  ): Promise<SubscriptionRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: SubscriptionRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    await this.client.query(
      `UPDATE everdict_subscriptions
       SET name=$3, selector=$4, reaction=$5, governance=$6, updated_at=$7
       WHERE tenant=$1 AND id=$2`,
      [
        tenant,
        id,
        next.name,
        JSON.stringify(next.selector),
        JSON.stringify(next.reaction),
        JSON.stringify(next.governance),
        next.updatedAt,
      ],
    );
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_subscriptions WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}
