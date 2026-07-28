import { type PlatformEventRecord, PlatformEventRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

import type { PlatformEventListOptions, PlatformEventStore } from "@everdict/application-control";

const DEFAULT_LIMIT = 100;

export class InMemoryPlatformEventStore implements PlatformEventStore {
  private readonly rows: PlatformEventRecord[] = [];
  private seq = 0;

  async append(record: Omit<PlatformEventRecord, "seq">): Promise<PlatformEventRecord> {
    this.seq += 1;
    const appended = PlatformEventRecordSchema.parse({ ...record, seq: this.seq });
    this.rows.push(appended);
    return appended;
  }

  async list(tenant: string, opts?: PlatformEventListOptions): Promise<PlatformEventRecord[]> {
    return this.filtered(opts, (r) => r.tenant === tenant);
  }

  async listAll(opts?: PlatformEventListOptions): Promise<PlatformEventRecord[]> {
    return this.filtered(opts, () => true);
  }

  private filtered(
    opts: PlatformEventListOptions | undefined,
    scope: (r: PlatformEventRecord) => boolean,
  ): PlatformEventRecord[] {
    return this.rows
      .filter(
        (r) =>
          scope(r) &&
          (opts?.afterSeq === undefined || r.seq > opts.afterSeq) &&
          (opts?.kinds === undefined || (opts.kinds as readonly string[]).includes(r.kind)),
      )
      .sort((a, b) => (opts?.order === "desc" ? b.seq - a.seq : a.seq - b.seq))
      .slice(0, opts?.limit ?? DEFAULT_LIMIT);
  }

  async get(tenant: string, id: string): Promise<PlatformEventRecord | undefined> {
    return this.rows.find((r) => r.tenant === tenant && r.id === id);
  }
}

interface PlatformEventRow {
  seq: string | number; // BIGSERIAL comes back as a string from pg
  id: string;
  tenant: string;
  kind: string;
  subject_type: string;
  subject_id: string;
  actor: string | null;
  payload: unknown;
  caused_by: string | null;
  message: string;
  created_at: string | Date;
}

function rowToRecord(row: PlatformEventRow): PlatformEventRecord {
  return PlatformEventRecordSchema.parse({
    seq: typeof row.seq === "string" ? Number(row.seq) : row.seq,
    id: row.id,
    tenant: row.tenant,
    kind: row.kind,
    subject: { type: row.subject_type, id: row.subject_id },
    ...(row.actor !== null ? { actor: row.actor } : {}),
    payload: row.payload ?? {},
    ...(row.caused_by !== null ? { causedBy: row.caused_by } : {}),
    message: row.message,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

export class PgPlatformEventStore implements PlatformEventStore {
  constructor(private readonly client: SqlClient) {}

  async append(record: Omit<PlatformEventRecord, "seq">): Promise<PlatformEventRecord> {
    const res = await this.client.query<{ seq: string | number }>(
      `INSERT INTO everdict_platform_events (id, tenant, kind, subject_type, subject_id, actor, payload, caused_by, message, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING seq`,
      [
        record.id,
        record.tenant,
        record.kind,
        record.subject.type,
        record.subject.id,
        record.actor ?? null,
        JSON.stringify(record.payload),
        record.causedBy ?? null,
        record.message,
        record.createdAt,
      ],
    );
    const seqValue = res.rows[0]?.seq;
    return PlatformEventRecordSchema.parse({
      ...record,
      seq: typeof seqValue === "string" ? Number(seqValue) : seqValue,
    });
  }

  async list(tenant: string, opts?: PlatformEventListOptions): Promise<PlatformEventRecord[]> {
    return this.query(opts, tenant);
  }

  async listAll(opts?: PlatformEventListOptions): Promise<PlatformEventRecord[]> {
    return this.query(opts, undefined);
  }

  private async query(opts: PlatformEventListOptions | undefined, tenant: string | undefined) {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (tenant !== undefined) {
      params.push(tenant);
      clauses.push(`tenant = $${params.length}`);
    }
    if (opts?.afterSeq !== undefined) {
      params.push(opts.afterSeq);
      clauses.push(`seq > $${params.length}`);
    }
    if (opts?.kinds !== undefined) {
      params.push(opts.kinds);
      clauses.push(`kind = ANY($${params.length})`);
    }
    params.push(opts?.limit ?? DEFAULT_LIMIT);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.client.query<PlatformEventRow>(
      `SELECT seq, id, tenant, kind, subject_type, subject_id, actor, payload, caused_by, message, created_at
       FROM everdict_platform_events${where}
       ORDER BY seq ${opts?.order === "desc" ? "DESC" : "ASC"} LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(rowToRecord);
  }

  async get(tenant: string, id: string): Promise<PlatformEventRecord | undefined> {
    const res = await this.client.query<PlatformEventRow>(
      `SELECT seq, id, tenant, kind, subject_type, subject_id, actor, payload, caused_by, message, created_at
       FROM everdict_platform_events WHERE tenant = $1 AND id = $2`,
      [tenant, id],
    );
    const row = res.rows[0];
    return row ? rowToRecord(row) : undefined;
  }
}
