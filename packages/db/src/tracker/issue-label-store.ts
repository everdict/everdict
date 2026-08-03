import type { IssueLabelStore, IssueStore, OutboxEvent } from "@everdict/application-control";
import { ConflictError, type IssueLabelRecord, IssueLabelRecordSchema, type IssueRecord } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { iso } from "./row.js";

// The workspace's label registry — same contract in-memory and on Postgres. Two properties are the store's to
// guarantee rather than the domain's, because both are about concurrency:
//   1. one label per name per workspace (case-insensitive), backed by the UNIQUE index from mig 0107;
//   2. deleting a label strips its id from every issue in the SAME transaction, so `labelIds` can never point
//      at a label that is gone.

interface IssueLabelRow {
  id: string;
  tenant: string;
  name: string;
  color: string;
  description: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const LABEL_COLUMNS = "(id, tenant, name, color, description, created_by, created_at, updated_at)";
const LABEL_VALUES = "($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz)";

function insertParams(record: IssueLabelRecord): unknown[] {
  return [
    record.id,
    record.tenant,
    record.name,
    record.color,
    record.description ?? null,
    record.createdBy,
    record.createdAt,
    record.updatedAt,
  ];
}

function rowToRecord(row: IssueLabelRow): IssueLabelRecord {
  return IssueLabelRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    name: row.name,
    color: row.color,
    ...(row.description !== null ? { description: row.description } : {}),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function duplicateName(name: string): ConflictError {
  return new ConflictError("CONFLICT", { name }, `A label named ${name} already exists in this workspace.`);
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

export class InMemoryIssueLabelStore implements IssueLabelStore {
  private readonly byId = new Map<string, IssueLabelRecord>();
  private readonly events: OutboxEvent[] = [];
  // Postgres gets both "how many issues wear this" and "strip it off them" from SQL over one table. In memory
  // the issues live in a SEPARATE object, so the composition root hands it over — without this the delete would
  // leave `labelIds` pointing at a label that no longer exists, the one invariant this store owes its callers.
  private issues: IssueStore | undefined;

  attachIssues(issues: IssueStore): void {
    this.issues = issues;
  }

  private async wearing(tenant: string, labelId: string): Promise<IssueRecord[]> {
    if (!this.issues) return [];
    const all = await this.issues.list(tenant);
    return all.filter((issue) => issue.labelIds.includes(labelId));
  }

  async create(record: IssueLabelRecord, events?: OutboxEvent[]): Promise<void> {
    const clash = [...this.byId.values()].find((x) => x.tenant === record.tenant && sameName(x.name, record.name));
    if (clash) throw duplicateName(record.name);
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<IssueLabelRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined; // another workspace's row reads as nonexistent
  }

  async getByName(tenant: string, name: string): Promise<IssueLabelRecord | undefined> {
    return [...this.byId.values()].find((x) => x.tenant === tenant && sameName(x.name, name));
  }

  async list(tenant: string): Promise<IssueLabelRecord[]> {
    return [...this.byId.values()]
      .filter((x) => x.tenant === tenant)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<IssueLabelRecord>,
    events?: OutboxEvent[],
  ): Promise<IssueLabelRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    if (patch.name !== undefined) {
      const clash = [...this.byId.values()].find(
        (x) => x.tenant === tenant && x.id !== id && sameName(x.name, patch.name ?? ""),
      );
      if (clash) throw duplicateName(patch.name);
    }
    const next = { ...current, ...patch };
    this.byId.set(id, next);
    if (events) this.events.push(...events);
    return next;
  }

  async remove(tenant: string, id: string, events?: OutboxEvent[]): Promise<boolean> {
    const current = await this.get(tenant, id);
    if (!current) return false;
    for (const issue of await this.wearing(tenant, id)) {
      await this.issues?.update(tenant, issue.id, {
        labelIds: issue.labelIds.filter((x) => x !== id),
      });
    }
    this.byId.delete(id);
    if (events) this.events.push(...events);
    return true;
  }

  async usageCount(tenant: string, id: string): Promise<number> {
    return (await this.wearing(tenant, id)).length;
  }
}

export class PgIssueLabelStore implements IssueLabelStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: IssueLabelRecord, events?: OutboxEvent[]): Promise<void> {
    const base = insertParams(record);
    // ON CONFLICT DO NOTHING + RETURNING lets one round trip both insert and detect the duplicate, instead of a
    // read-then-write that two concurrent definitions could both pass.
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      const { rows } = await this.client.query<{ id: string }>(
        `WITH ins AS (
           INSERT INTO everdict_issue_labels ${LABEL_COLUMNS} VALUES ${LABEL_VALUES}
           ON CONFLICT DO NOTHING RETURNING id
         ), ev AS (
           INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
           SELECT * FROM (VALUES ${ev.sql}) AS v
           WHERE EXISTS (SELECT 1 FROM ins)
         )
         SELECT id FROM ins`,
        [...base, ...ev.params],
      );
      if (rows.length === 0) throw duplicateName(record.name);
      return;
    }
    const { rows } = await this.client.query<{ id: string }>(
      `INSERT INTO everdict_issue_labels ${LABEL_COLUMNS} VALUES ${LABEL_VALUES}
       ON CONFLICT DO NOTHING RETURNING id`,
      base,
    );
    if (rows.length === 0) throw duplicateName(record.name);
  }

  async get(tenant: string, id: string): Promise<IssueLabelRecord | undefined> {
    const { rows } = await this.client.query<IssueLabelRow>(
      "SELECT * FROM everdict_issue_labels WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async getByName(tenant: string, name: string): Promise<IssueLabelRecord | undefined> {
    const { rows } = await this.client.query<IssueLabelRow>(
      "SELECT * FROM everdict_issue_labels WHERE tenant=$1 AND lower(name)=lower($2)",
      [tenant, name.trim()],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string): Promise<IssueLabelRecord[]> {
    const { rows } = await this.client.query<IssueLabelRow>(
      "SELECT * FROM everdict_issue_labels WHERE tenant=$1 ORDER BY name ASC",
      [tenant],
    );
    return rows.map(rowToRecord);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<IssueLabelRecord>,
    events?: OutboxEvent[],
  ): Promise<IssueLabelRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    const base = [tenant, id, next.name, next.color, next.description ?? null, next.updatedAt];
    const sets = "name=$3, color=$4, description=$5, updated_at=$6::timestamptz";
    const run = async (sql: string, params: unknown[]) => {
      const { rows } = await this.client.query<IssueLabelRow>(sql, params);
      return rows[0] ? rowToRecord(rows[0]) : undefined;
    };
    try {
      if (events && events.length > 0) {
        const ev = eventValuesClause(events, base.length + 1);
        return await run(
          `WITH upd AS (
             UPDATE everdict_issue_labels SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *
           ), ev AS (
             INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
             SELECT * FROM (VALUES ${ev.sql}) AS v
             WHERE EXISTS (SELECT 1 FROM upd)
           )
           SELECT * FROM upd`,
          [...base, ...ev.params],
        );
      }
      return await run(
        `UPDATE everdict_issue_labels SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *`,
        base,
      );
    } catch (e) {
      // The UNIQUE index is the authority on "that name is taken"; remap it rather than leaking a driver error.
      if (e instanceof Error && /everdict_issue_labels_tenant_name/.test(e.message)) throw duplicateName(next.name);
      throw e;
    }
  }

  // One statement: delete the label and strip its id out of every issue that wears it. `jsonb - text` removes a
  // string element from a jsonb array, and jsonb_exists narrows the UPDATE to the rows that actually carry it.
  async remove(tenant: string, id: string, events?: OutboxEvent[]): Promise<boolean> {
    const base = [tenant, id];
    const strip = `stripped AS (
        UPDATE everdict_issues SET label_ids = label_ids - $2
        WHERE tenant=$1 AND jsonb_exists(label_ids, $2) AND EXISTS (SELECT 1 FROM del)
      )`;
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      const { rows } = await this.client.query<{ id: string }>(
        `WITH del AS (DELETE FROM everdict_issue_labels WHERE tenant=$1 AND id=$2 RETURNING id),
              ${strip},
              ev AS (
                INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM del)
              )
         SELECT id FROM del`,
        [...base, ...ev.params],
      );
      return rows.length > 0;
    }
    const { rows } = await this.client.query<{ id: string }>(
      `WITH del AS (DELETE FROM everdict_issue_labels WHERE tenant=$1 AND id=$2 RETURNING id),
            ${strip}
       SELECT id FROM del`,
      base,
    );
    return rows.length > 0;
  }

  async usageCount(tenant: string, id: string): Promise<number> {
    const { rows } = await this.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM everdict_issues WHERE tenant=$1 AND jsonb_exists(label_ids, $2)",
      [tenant, id],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
