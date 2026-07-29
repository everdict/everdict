import type { FsRevisionStore } from "@everdict/application-control";
import { ConflictError, type FsRevision, FsRevisionSchema } from "@everdict/contracts";

import type { SqlClient } from "../client.js";

// The workspace filesystem's publication ledger — see the port for the contract. Both impls treat ONE rule as
// sacred: appending a (tenant, path, revision) that already exists is a lost race and throws ConflictError.
// That is what makes concurrent editing safe, so it is asserted in the store rather than hoped for upstream.

const DEFAULT_LIMIT = 50;

const newestFirst = (a: FsRevision, b: FsRevision): number => b.revision - a.revision;

export class InMemoryFsRevisionStore implements FsRevisionStore {
  private readonly rows: FsRevision[] = [];

  async append(record: FsRevision): Promise<void> {
    if (this.rows.some((r) => r.tenant === record.tenant && r.path === record.path && r.revision === record.revision)) {
      throw new ConflictError(
        "CONFLICT",
        { path: record.path, revision: record.revision },
        `revision ${record.revision} of '${record.path}' was already published`,
      );
    }
    this.rows.push(record);
  }

  async head(tenant: string, path: string): Promise<FsRevision | undefined> {
    return this.forPath(tenant, path)[0];
  }

  async list(tenant: string, path: string, opts?: { limit?: number }): Promise<FsRevision[]> {
    return this.forPath(tenant, path).slice(0, opts?.limit ?? DEFAULT_LIMIT);
  }

  async get(tenant: string, path: string, revision: number): Promise<FsRevision | undefined> {
    return this.rows.find((r) => r.tenant === tenant && r.path === path && r.revision === revision);
  }

  async rename(tenant: string, from: string, to: string): Promise<void> {
    for (const [i, row] of this.rows.entries()) {
      if (row.tenant !== tenant) continue;
      if (row.path === from) this.rows[i] = { ...row, path: to };
      else if (row.path.startsWith(`${from}/`))
        this.rows[i] = { ...row, path: `${to}/${row.path.slice(from.length + 1)}` };
    }
  }

  private forPath(tenant: string, path: string): FsRevision[] {
    return this.rows.filter((r) => r.tenant === tenant && r.path === path).sort(newestFirst);
  }
}

interface FsRevisionRow {
  tenant: string;
  path: string;
  revision: number | string;
  size: number | string;
  content_type: string;
  hash: string;
  actor: unknown;
  message: string | null;
  restored_from: number | string | null;
  created_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());
const int = (v: number | string): number => (typeof v === "number" ? v : Number.parseInt(v, 10));

function rowToRecord(row: FsRevisionRow): FsRevision {
  return FsRevisionSchema.parse({
    tenant: row.tenant,
    path: row.path,
    revision: int(row.revision),
    size: int(row.size), // bigint arrives as a string from pg
    contentType: row.content_type,
    hash: row.hash,
    actor: row.actor,
    ...(row.message !== null ? { message: row.message } : {}),
    ...(row.restored_from !== null ? { restoredFrom: int(row.restored_from) } : {}),
    createdAt: iso(row.created_at),
  });
}

// Postgres — the primary key does the allocation. `ON CONFLICT DO NOTHING` + a returning-row check turns the
// race into our ConflictError without depending on driver-specific error codes.
export class PgFsRevisionStore implements FsRevisionStore {
  constructor(private readonly client: SqlClient) {}

  async append(record: FsRevision): Promise<void> {
    const { rows } = await this.client.query<{ revision: number | string }>(
      `INSERT INTO everdict_fs_revisions (tenant, path, revision, size, content_type, hash, actor, message, restored_from, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant, path, revision) DO NOTHING
       RETURNING revision`,
      [
        record.tenant,
        record.path,
        record.revision,
        record.size,
        record.contentType,
        record.hash,
        JSON.stringify(record.actor),
        record.message ?? null,
        record.restoredFrom ?? null,
        record.createdAt,
      ],
    );
    if (rows.length === 0) {
      throw new ConflictError(
        "CONFLICT",
        { path: record.path, revision: record.revision },
        `revision ${record.revision} of '${record.path}' was already published`,
      );
    }
  }

  async head(tenant: string, path: string): Promise<FsRevision | undefined> {
    const { rows } = await this.client.query<FsRevisionRow>(
      "SELECT * FROM everdict_fs_revisions WHERE tenant=$1 AND path=$2 ORDER BY revision DESC LIMIT 1",
      [tenant, path],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string, path: string, opts?: { limit?: number }): Promise<FsRevision[]> {
    const { rows } = await this.client.query<FsRevisionRow>(
      "SELECT * FROM everdict_fs_revisions WHERE tenant=$1 AND path=$2 ORDER BY revision DESC LIMIT $3",
      [tenant, path, opts?.limit ?? DEFAULT_LIMIT],
    );
    return rows.map(rowToRecord);
  }

  async get(tenant: string, path: string, revision: number): Promise<FsRevision | undefined> {
    const { rows } = await this.client.query<FsRevisionRow>(
      "SELECT * FROM everdict_fs_revisions WHERE tenant=$1 AND path=$2 AND revision=$3",
      [tenant, path, revision],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  // A move rewrites the stored path — the file keeps its history instead of starting over at revision 1. Both the
  // exact path (a file move) and its subtree prefix (a directory move) are rewritten in one statement.
  async rename(tenant: string, from: string, to: string): Promise<void> {
    await this.client.query(
      `UPDATE everdict_fs_revisions
       SET path = CASE WHEN path = $2 THEN $3 ELSE $3 || substring(path from char_length($2) + 1) END
       WHERE tenant = $1 AND (path = $2 OR path LIKE $2 || '/%')`,
      [tenant, from, to],
    );
  }
}
