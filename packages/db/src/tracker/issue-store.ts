import type { IssueListFilter, IssueStore, OutboxEvent } from "@everdict/application-control";
import { type IssueRecord, IssueRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { type TrackerRow, iso, trackerHistory } from "./row.js";

// The tracker's issue ledger — same contract in-memory and on Postgres. Facts ride the E0 same-tx outbox
// (one statement, two writes), so an issue's state change and the fact describing it commit together.

function matchesFilter(record: IssueRecord, filter: IssueListFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.status !== undefined && record.status !== filter.status) return false;
  if (filter.teamId !== undefined && record.teamId !== filter.teamId) return false;
  if (filter.teamIds !== undefined && !filter.teamIds.includes(record.teamId)) return false;
  if (filter.projectId !== undefined && record.projectId !== filter.projectId) return false;
  if (filter.assignee !== undefined && record.assignee !== filter.assignee) return false;
  if (filter.githubRepository !== undefined && record.github?.repository !== filter.githubRepository) return false;
  if (filter.syncPull === true && record.github?.sync.pull !== true) return false;
  if (filter.link !== undefined) {
    const { type, id } = filter.link;
    if (!record.links.some((link) => link.type === type && link.id === id)) return false;
  }
  return true;
}

export class InMemoryIssueStore implements IssueStore {
  private readonly byId = new Map<string, IssueRecord>();
  private readonly events: OutboxEvent[] = [];

  async create(record: IssueRecord, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<IssueRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined; // another workspace's row reads as nonexistent
  }

  async getByIdentifier(tenant: string, identifier: string): Promise<IssueRecord | undefined> {
    return [...this.byId.values()].find((record) => record.tenant === tenant && record.identifier === identifier);
  }

  async getByGithub(
    tenant: string,
    repository: string,
    number: number,
    host?: string,
  ): Promise<IssueRecord | undefined> {
    return [...this.byId.values()].find(
      (record) =>
        record.tenant === tenant &&
        record.github?.repository === repository &&
        record.github.number === number &&
        record.github.host === host,
    );
  }

  async list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]> {
    const rows = [...this.byId.values()]
      .filter((record) => record.tenant === tenant && matchesFilter(record, filter))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<IssueRecord>,
    events?: OutboxEvent[],
  ): Promise<IssueRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next: IssueRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    this.byId.set(id, next);
    if (events) this.events.push(...events);
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    const current = this.byId.get(id);
    if (current && current.tenant === tenant) this.byId.delete(id);
  }

  // Test/dev inspection of the outbox half — the Pg impl's equivalent is the platform-events table.
  emittedEvents(): OutboxEvent[] {
    return [...this.events];
  }
}

interface IssueRow extends TrackerRow {
  team_id: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  status: string;
  project_id: string | null;
  assignee: string | null;
  label_ids: unknown;
  links: unknown;
  resolution: unknown;
  github: unknown;
  origin: unknown;
}

const ISSUE_COLUMNS =
  "(id, tenant, team_id, number, identifier, title, description, status, project_id, assignee, label_ids, links, resolution, github, history, created_by, origin, created_at, updated_at)";
const ISSUE_VALUES =
  "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17::jsonb,$18::timestamptz,$19::timestamptz)";

function insertParams(record: IssueRecord): unknown[] {
  return [
    record.id,
    record.tenant,
    record.teamId,
    record.number,
    record.identifier,
    record.title,
    record.description ?? null,
    record.status,
    record.projectId ?? null,
    record.assignee ?? null,
    JSON.stringify(record.labelIds),
    JSON.stringify(record.links),
    record.resolution === undefined ? null : JSON.stringify(record.resolution),
    record.github === undefined ? null : JSON.stringify(record.github),
    JSON.stringify(record.history),
    record.createdBy,
    record.origin === undefined ? null : JSON.stringify(record.origin),
    record.createdAt,
    record.updatedAt,
  ];
}

function rowToRecord(row: IssueRow): IssueRecord {
  return IssueRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    teamId: row.team_id,
    number: row.number,
    identifier: row.identifier,
    title: row.title,
    ...(row.description !== null ? { description: row.description } : {}),
    status: row.status,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.assignee !== null ? { assignee: row.assignee } : {}),
    labelIds: row.label_ids ?? [],
    links: row.links ?? [],
    ...(row.resolution !== null ? { resolution: row.resolution } : {}),
    ...(row.github !== null ? { github: row.github } : {}),
    history: trackerHistory(row.history),
    createdBy: row.created_by,
    ...(row.origin !== null ? { origin: row.origin } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class PgIssueStore implements IssueStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: IssueRecord, events?: OutboxEvent[]): Promise<void> {
    const base = insertParams(record);
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_issues ${ISSUE_COLUMNS} VALUES ${ISSUE_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_issues ${ISSUE_COLUMNS} VALUES ${ISSUE_VALUES}`, base);
  }

  async get(tenant: string, id: string): Promise<IssueRecord | undefined> {
    const { rows } = await this.client.query<IssueRow>("SELECT * FROM everdict_issues WHERE tenant=$1 AND id=$2", [
      tenant,
      id,
    ]);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  // Served by the (tenant, identifier) unique index from migration 0105 — the same index that makes the
  // identifier a safe URL key in the first place.
  async getByIdentifier(tenant: string, identifier: string): Promise<IssueRecord | undefined> {
    const { rows } = await this.client.query<IssueRow>(
      "SELECT * FROM everdict_issues WHERE tenant=$1 AND identifier=$2",
      [tenant, identifier],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async getByGithub(
    tenant: string,
    repository: string,
    number: number,
    host?: string,
  ): Promise<IssueRecord | undefined> {
    const { rows } = await this.client.query<IssueRow>(
      `SELECT * FROM everdict_issues
       WHERE tenant=$1 AND github->>'repository' = $2 AND (github->>'number')::int = $3
         AND (github->>'host') IS NOT DISTINCT FROM $4
       LIMIT 1`,
      [tenant, repository, number, host ?? null],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]> {
    const conds = ["tenant = $1"];
    const params: unknown[] = [tenant];
    let i = 2;
    if (filter?.status !== undefined) {
      conds.push(`status = $${i++}`);
      params.push(filter.status);
    }
    if (filter?.teamId !== undefined) {
      conds.push(`team_id = $${i++}`);
      params.push(filter.teamId);
    }
    if (filter?.teamIds !== undefined) {
      // Empty roster = no rows, expressed as a false predicate rather than an `IN ()` the parser rejects.
      if (filter.teamIds.length === 0) conds.push("false");
      else {
        conds.push(`team_id = ANY($${i++}::text[])`);
        params.push(filter.teamIds);
      }
    }
    if (filter?.projectId !== undefined) {
      conds.push(`project_id = $${i++}`);
      params.push(filter.projectId);
    }
    if (filter?.assignee !== undefined) {
      conds.push(`assignee = $${i++}`);
      params.push(filter.assignee);
    }
    if (filter?.githubRepository !== undefined) {
      conds.push(`github->>'repository' = $${i++}`);
      params.push(filter.githubRepository);
    }
    if (filter?.syncPull === true) conds.push("(github->'sync'->>'pull') = 'true'");
    if (filter?.link !== undefined) {
      // Containment over the links array — id-level, version-agnostic (a cross-version regression is the signal).
      conds.push(`links @> $${i++}::jsonb`);
      params.push(JSON.stringify([{ type: filter.link.type, id: filter.link.id }]));
    }
    let sql = `SELECT * FROM everdict_issues WHERE ${conds.join(" AND ")} ORDER BY updated_at DESC`;
    if (filter?.limit !== undefined) {
      sql += ` LIMIT $${i++}`;
      params.push(filter.limit);
    }
    const { rows } = await this.client.query<IssueRow>(sql, params);
    return rows.map(rowToRecord);
  }

  // Fetch-merge-write: the tracker is low-contention (a human or one consumer at a time), and the merge keeps
  // the jsonb columns whole rather than hand-writing a SET clause per optional field.
  async update(
    tenant: string,
    id: string,
    patch: Partial<IssueRecord>,
    events?: OutboxEvent[],
  ): Promise<IssueRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: IssueRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    const sets = `title=$3, description=$4, status=$5, project_id=$6, assignee=$7, label_ids=$8::jsonb, links=$9::jsonb,
       resolution=$10::jsonb, github=$11::jsonb, history=$12::jsonb, origin=$13::jsonb, updated_at=$14::timestamptz`;
    const params: unknown[] = [
      tenant,
      id,
      next.title,
      next.description ?? null,
      next.status,
      next.projectId ?? null,
      next.assignee ?? null,
      JSON.stringify(next.labelIds),
      JSON.stringify(next.links),
      next.resolution === undefined ? null : JSON.stringify(next.resolution),
      next.github === undefined ? null : JSON.stringify(next.github),
      JSON.stringify(next.history),
      next.origin === undefined ? null : JSON.stringify(next.origin),
      next.updatedAt,
    ];
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, params.length + 1);
      const { rows } = await this.client.query<IssueRow>(
        `WITH upd AS (UPDATE everdict_issues SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...params, ...ev.params],
      );
      return rows[0] ? rowToRecord(rows[0]) : undefined;
    }
    const { rows } = await this.client.query<IssueRow>(
      `UPDATE everdict_issues SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *`,
      params,
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_issues WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}
