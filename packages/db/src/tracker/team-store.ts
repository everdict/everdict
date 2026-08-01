import type { IssueNumberGrant, OutboxEvent, TeamListFilter, TeamStore } from "@everdict/application-control";
import {
  type TeamMemberRecord,
  TeamMemberRecordSchema,
  type TeamRecord,
  TeamRecordSchema,
  formatIssueIdentifier,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { type TrackerRow, iso, trackerHistory } from "./row.js";

// The tracker's team ledger + roster — same contract in-memory and on Postgres. Facts ride the E0 same-tx
// outbox, and the issue-number allocation is a single conditional UPDATE so a concurrent filing cannot be
// handed a number that is already spoken for.

export class InMemoryTeamStore implements TeamStore {
  private readonly byId = new Map<string, TeamRecord>();
  private readonly members: TeamMemberRecord[] = [];
  private readonly events: OutboxEvent[] = [];

  async create(record: TeamRecord, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<TeamRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined; // another workspace's row reads as nonexistent
  }

  async getByKey(tenant: string, key: string): Promise<TeamRecord | undefined> {
    return [...this.byId.values()].find((record) => record.tenant === tenant && record.key === key);
  }

  async getDefault(tenant: string): Promise<TeamRecord | undefined> {
    return [...this.byId.values()].find((record) => record.tenant === tenant && record.isDefault);
  }

  async list(tenant: string, filter?: TeamListFilter): Promise<TeamRecord[]> {
    const mine =
      filter?.member === undefined
        ? undefined
        : new Set(this.members.filter((m) => m.tenant === tenant && m.subject === filter.member).map((m) => m.teamId));
    const rows = [...this.byId.values()]
      .filter((record) => record.tenant === tenant && (mine === undefined || mine.has(record.id)))
      .sort((a, b) => a.key.localeCompare(b.key));
    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  async count(tenant: string): Promise<number> {
    return [...this.byId.values()].filter((record) => record.tenant === tenant).length;
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<TeamRecord>,
    events?: OutboxEvent[],
  ): Promise<TeamRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next: TeamRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    this.byId.set(id, next);
    if (events) this.events.push(...events);
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    const current = this.byId.get(id);
    if (current && current.tenant === tenant) {
      this.byId.delete(id);
      for (let i = this.members.length - 1; i >= 0; i -= 1)
        if (this.members[i]?.tenant === tenant && this.members[i]?.teamId === id) this.members.splice(i, 1);
    }
  }

  async allocateIssueNumber(tenant: string, id: string, now: string): Promise<IssueNumberGrant | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next = current.issueCounter + 1;
    this.byId.set(id, { ...current, issueCounter: next, updatedAt: now });
    return { number: next, identifier: formatIssueIdentifier(current.key, next) };
  }

  async listMembers(tenant: string, teamId: string): Promise<TeamMemberRecord[]> {
    return this.members
      .filter((m) => m.tenant === tenant && m.teamId === teamId)
      .sort((a, b) => a.subject.localeCompare(b.subject));
  }

  async addMember(record: TeamMemberRecord, events?: OutboxEvent[]): Promise<void> {
    const existing = this.members.find(
      (m) => m.tenant === record.tenant && m.teamId === record.teamId && m.subject === record.subject,
    );
    if (!existing) this.members.push(record);
    if (events) this.events.push(...events);
  }

  async removeMember(tenant: string, teamId: string, subject: string, events?: OutboxEvent[]): Promise<boolean> {
    const index = this.members.findIndex((m) => m.tenant === tenant && m.teamId === teamId && m.subject === subject);
    if (index < 0) return false;
    this.members.splice(index, 1);
    if (events) this.events.push(...events);
    return true;
  }

  // Test/dev inspection of the outbox half — the Pg impl's equivalent is the platform-events table.
  emittedEvents(): OutboxEvent[] {
    return [...this.events];
  }
}

interface TeamRow extends TrackerRow {
  key: string;
  name: string;
  description: string | null;
  is_default: boolean;
  issue_counter: number;
}

interface TeamMemberRow {
  tenant: string;
  team_id: string;
  subject: string;
  added_by: string;
  added_at: string | Date;
}

const TEAM_COLUMNS =
  "(id, tenant, key, name, description, is_default, issue_counter, history, created_by, created_at, updated_at)";
const TEAM_VALUES = "($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::timestamptz,$11::timestamptz)";

function insertParams(record: TeamRecord): unknown[] {
  return [
    record.id,
    record.tenant,
    record.key,
    record.name,
    record.description ?? null,
    record.isDefault,
    record.issueCounter,
    JSON.stringify(record.history),
    record.createdBy,
    record.createdAt,
    record.updatedAt,
  ];
}

function rowToRecord(row: TeamRow): TeamRecord {
  return TeamRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    key: row.key,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    isDefault: row.is_default,
    issueCounter: row.issue_counter,
    history: trackerHistory(row.history),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function rowToMember(row: TeamMemberRow): TeamMemberRecord {
  return TeamMemberRecordSchema.parse({
    tenant: row.tenant,
    teamId: row.team_id,
    subject: row.subject,
    addedBy: row.added_by,
    addedAt: iso(row.added_at),
  });
}

// Column → patch mapping for update(). Listed explicitly (not derived) so an unknown key can never build SQL.
const PATCH_COLUMNS: Record<string, string> = {
  name: "name",
  description: "description",
  isDefault: "is_default",
  issueCounter: "issue_counter",
  history: "history",
  updatedAt: "updated_at",
};

export class PgTeamStore implements TeamStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: TeamRecord, events?: OutboxEvent[]): Promise<void> {
    const base = insertParams(record);
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_teams ${TEAM_COLUMNS} VALUES ${TEAM_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_teams ${TEAM_COLUMNS} VALUES ${TEAM_VALUES}`, base);
  }

  async get(tenant: string, id: string): Promise<TeamRecord | undefined> {
    const { rows } = await this.client.query<TeamRow>("SELECT * FROM everdict_teams WHERE tenant=$1 AND id=$2", [
      tenant,
      id,
    ]);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async getByKey(tenant: string, key: string): Promise<TeamRecord | undefined> {
    const { rows } = await this.client.query<TeamRow>("SELECT * FROM everdict_teams WHERE tenant=$1 AND key=$2", [
      tenant,
      key,
    ]);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async getDefault(tenant: string): Promise<TeamRecord | undefined> {
    const { rows } = await this.client.query<TeamRow>(
      "SELECT * FROM everdict_teams WHERE tenant=$1 AND is_default LIMIT 1",
      [tenant],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string, filter?: TeamListFilter): Promise<TeamRecord[]> {
    const params: unknown[] = [tenant];
    let sql = "SELECT t.* FROM everdict_teams t";
    if (filter?.member !== undefined) {
      params.push(filter.member);
      sql += ` JOIN everdict_team_members m ON m.tenant=t.tenant AND m.team_id=t.id AND m.subject=$${params.length}`;
    }
    sql += " WHERE t.tenant=$1 ORDER BY t.key ASC";
    if (filter?.limit !== undefined) {
      params.push(filter.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const { rows } = await this.client.query<TeamRow>(sql, params);
    return rows.map(rowToRecord);
  }

  async count(tenant: string): Promise<number> {
    const { rows } = await this.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM everdict_teams WHERE tenant=$1",
      [tenant],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<TeamRecord>,
    events?: OutboxEvent[],
  ): Promise<TeamRecord | undefined> {
    const sets: string[] = [];
    const params: unknown[] = [tenant, id];
    for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
      const value = (patch as Record<string, unknown>)[field];
      if (value === undefined && !(field in patch)) continue;
      params.push(
        field === "history" ? JSON.stringify(value ?? []) : field === "description" ? (value ?? null) : value,
      );
      sets.push(`${column}=$${params.length}${field === "history" ? "::jsonb" : ""}`);
    }
    if (sets.length === 0) return this.get(tenant, id);
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, params.length + 1);
      const { rows } = await this.client.query<TeamRow>(
        `WITH upd AS (UPDATE everdict_teams SET ${sets.join(", ")} WHERE tenant=$1 AND id=$2 RETURNING *),
              ins AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                      SELECT * FROM (VALUES ${ev.sql}) AS v WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...params, ...ev.params],
      );
      return rows[0] ? rowToRecord(rows[0]) : undefined;
    }
    const { rows } = await this.client.query<TeamRow>(
      `UPDATE everdict_teams SET ${sets.join(", ")} WHERE tenant=$1 AND id=$2 RETURNING *`,
      params,
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_team_members WHERE tenant=$1 AND team_id=$2", [tenant, id]);
    await this.client.query("DELETE FROM everdict_teams WHERE tenant=$1 AND id=$2", [tenant, id]);
  }

  // The increment and the read are ONE statement: a read-then-write would let two concurrent filings observe
  // the same counter and mint the same identifier.
  async allocateIssueNumber(tenant: string, id: string, now: string): Promise<IssueNumberGrant | undefined> {
    const { rows } = await this.client.query<{ key: string; issue_counter: number }>(
      `UPDATE everdict_teams SET issue_counter = issue_counter + 1, updated_at = $3::timestamptz
       WHERE tenant=$1 AND id=$2 RETURNING key, issue_counter`,
      [tenant, id, now],
    );
    const row = rows[0];
    return row
      ? { number: row.issue_counter, identifier: formatIssueIdentifier(row.key, row.issue_counter) }
      : undefined;
  }

  async listMembers(tenant: string, teamId: string): Promise<TeamMemberRecord[]> {
    const { rows } = await this.client.query<TeamMemberRow>(
      "SELECT * FROM everdict_team_members WHERE tenant=$1 AND team_id=$2 ORDER BY subject ASC",
      [tenant, teamId],
    );
    return rows.map(rowToMember);
  }

  async addMember(record: TeamMemberRecord, events?: OutboxEvent[]): Promise<void> {
    const base = [record.tenant, record.teamId, record.subject, record.addedBy, record.addedAt];
    const values = "($1,$2,$3,$4,$5::timestamptz)";
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_team_members (tenant, team_id, subject, added_by, added_at)
                      VALUES ${values} ON CONFLICT DO NOTHING RETURNING subject)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(
      `INSERT INTO everdict_team_members (tenant, team_id, subject, added_by, added_at) VALUES ${values} ON CONFLICT DO NOTHING`,
      base,
    );
  }

  async removeMember(tenant: string, teamId: string, subject: string, events?: OutboxEvent[]): Promise<boolean> {
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, 4);
      const { rows } = await this.client.query<{ subject: string }>(
        `WITH del AS (DELETE FROM everdict_team_members WHERE tenant=$1 AND team_id=$2 AND subject=$3 RETURNING subject),
              ins AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                      SELECT * FROM (VALUES ${ev.sql}) AS v WHERE EXISTS (SELECT 1 FROM del))
         SELECT * FROM del`,
        [tenant, teamId, subject, ...ev.params],
      );
      return rows.length > 0;
    }
    const { rows } = await this.client.query<{ subject: string }>(
      "DELETE FROM everdict_team_members WHERE tenant=$1 AND team_id=$2 AND subject=$3 RETURNING subject",
      [tenant, teamId, subject],
    );
    return rows.length > 0;
  }
}
