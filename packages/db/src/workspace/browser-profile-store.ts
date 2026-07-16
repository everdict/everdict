import { type BrowserProfileRecord, BrowserProfileRecordSchema } from "@everdict/contracts";

import type { BrowserProfileStore } from "@everdict/application-control";

import type { SqlClient } from "../client.js";

// Saved authenticated browser profiles (browser-profiles S2) — personal / self-scoped metadata. Same contract,
// InMemory (dev/tests) + Pg (DATABASE_URL). The encrypted storageState blob (S3) lives in @everdict/storage, keyed
// by (tenant, profileId); this store holds only the metadata.
export class InMemoryBrowserProfileStore implements BrowserProfileStore {
  private readonly byId = new Map<string, BrowserProfileRecord>();

  async create(record: BrowserProfileRecord): Promise<void> {
    this.byId.set(record.id, record);
  }

  async get(tenant: string, id: string): Promise<BrowserProfileRecord | undefined> {
    const r = this.byId.get(id);
    return r && r.tenant === tenant ? r : undefined; // another workspace's is nonexistent
  }

  async listOwned(tenant: string, subject: string): Promise<BrowserProfileRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant && r.createdBy === subject)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<BrowserProfileRecord>,
  ): Promise<BrowserProfileRecord | undefined> {
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

interface BrowserProfileRow {
  id: string;
  tenant: string;
  name: string;
  cookie_domains: unknown;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

function rowToRecord(row: BrowserProfileRow): BrowserProfileRecord {
  return BrowserProfileRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    name: row.name,
    cookieDomains: row.cookie_domains,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

// Postgres browser-profile store — same contract as in-memory. cookie_domains is jsonb.
export class PgBrowserProfileStore implements BrowserProfileStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: BrowserProfileRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_browser_profiles (id, tenant, name, cookie_domains, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        record.id,
        record.tenant,
        record.name,
        JSON.stringify(record.cookieDomains),
        record.createdBy,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async get(tenant: string, id: string): Promise<BrowserProfileRecord | undefined> {
    const { rows } = await this.client.query<BrowserProfileRow>(
      "SELECT * FROM everdict_browser_profiles WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async listOwned(tenant: string, subject: string): Promise<BrowserProfileRecord[]> {
    const { rows } = await this.client.query<BrowserProfileRow>(
      `SELECT * FROM everdict_browser_profiles
       WHERE tenant=$1 AND created_by=$2
       ORDER BY created_at DESC`,
      [tenant, subject],
    );
    return rows.map(rowToRecord);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<BrowserProfileRecord>,
  ): Promise<BrowserProfileRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: BrowserProfileRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    await this.client.query(
      "UPDATE everdict_browser_profiles SET name=$3, cookie_domains=$4, updated_at=$5 WHERE tenant=$1 AND id=$2",
      [tenant, id, next.name, JSON.stringify(next.cookieDomains), next.updatedAt],
    );
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_browser_profiles WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}
