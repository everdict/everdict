import { type KnowledgeEntryRecord, KnowledgeEntryRecordSchema } from "@everdict/contracts";

import type { KnowledgeEntryStore } from "@everdict/application-control";

import type { SqlClient } from "../client.js";

// Knowledge entries — reified claims (the knowledge layer's record). Dual-scoped private|workspace like Skills;
// `list` returns every workspace entry in the tenant plus the caller's own private ones (the manage gate is
// per-visibility, in the service). Same contract, InMemory (dev/tests) + Pg (DATABASE_URL). Mirrors the skill store.
export class InMemoryKnowledgeEntryStore implements KnowledgeEntryStore {
  private readonly byId = new Map<string, KnowledgeEntryRecord>();

  async create(record: KnowledgeEntryRecord): Promise<void> {
    this.byId.set(record.id, record);
  }

  async get(tenant: string, id: string): Promise<KnowledgeEntryRecord | undefined> {
    const r = this.byId.get(id);
    return r && r.tenant === tenant ? r : undefined; // another workspace's is nonexistent
  }

  async list(tenant: string, subject: string): Promise<KnowledgeEntryRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant && (r.visibility === "workspace" || r.createdBy === subject))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<KnowledgeEntryRecord>,
  ): Promise<KnowledgeEntryRecord | undefined> {
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

interface KnowledgeEntryRow {
  id: string;
  tenant: string;
  kind: string;
  title: string;
  body: string;
  refs: unknown;
  evidence: unknown;
  status: string;
  supersedes: string | null;
  visibility: string;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
  verified_at: string | Date | null;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

function rowToRecord(row: KnowledgeEntryRow): KnowledgeEntryRecord {
  return KnowledgeEntryRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    kind: row.kind,
    title: row.title,
    body: row.body,
    refs: row.refs ?? [],
    evidence: row.evidence ?? [],
    status: row.status,
    ...(row.supersedes !== null && row.supersedes !== "" ? { supersedes: row.supersedes } : {}),
    visibility: row.visibility,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.verified_at !== null ? { verifiedAt: iso(row.verified_at) } : {}),
  });
}

// Postgres knowledge-entry store — same contract as in-memory.
export class PgKnowledgeEntryStore implements KnowledgeEntryStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: KnowledgeEntryRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_knowledge_entries (id, tenant, kind, title, body, refs, evidence, status, supersedes, visibility, created_by, created_at, updated_at, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        record.id,
        record.tenant,
        record.kind,
        record.title,
        record.body,
        JSON.stringify(record.refs),
        JSON.stringify(record.evidence),
        record.status,
        record.supersedes ?? null,
        record.visibility,
        record.createdBy,
        record.createdAt,
        record.updatedAt,
        record.verifiedAt ?? null,
      ],
    );
  }

  async get(tenant: string, id: string): Promise<KnowledgeEntryRecord | undefined> {
    const { rows } = await this.client.query<KnowledgeEntryRow>(
      "SELECT * FROM everdict_knowledge_entries WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string, subject: string): Promise<KnowledgeEntryRecord[]> {
    const { rows } = await this.client.query<KnowledgeEntryRow>(
      `SELECT * FROM everdict_knowledge_entries
       WHERE tenant=$1 AND (visibility='workspace' OR created_by=$2)
       ORDER BY created_at DESC`,
      [tenant, subject],
    );
    return rows.map(rowToRecord);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<KnowledgeEntryRecord>,
  ): Promise<KnowledgeEntryRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: KnowledgeEntryRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    await this.client.query(
      `UPDATE everdict_knowledge_entries
       SET kind=$3, title=$4, body=$5, refs=$6, evidence=$7, status=$8, supersedes=$9, visibility=$10, updated_at=$11, verified_at=$12
       WHERE tenant=$1 AND id=$2`,
      [
        tenant,
        id,
        next.kind,
        next.title,
        next.body,
        JSON.stringify(next.refs),
        JSON.stringify(next.evidence),
        next.status,
        next.supersedes ?? null,
        next.visibility,
        next.updatedAt,
        next.verifiedAt ?? null,
      ],
    );
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_knowledge_entries WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}
