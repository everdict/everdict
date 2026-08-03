import type { WorkflowStateStore } from "@everdict/application-control";
import { type WorkflowStateRecord, WorkflowStateRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { iso } from "./row.js";

// A team's named workflow states — same contract in-memory and on Postgres. Always ordered by `position`: the
// board IS the order, so a store that returned them by name would be returning a different thing.

export class InMemoryWorkflowStateStore implements WorkflowStateStore {
  private readonly byId = new Map<string, WorkflowStateRecord>();

  async create(record: WorkflowStateRecord): Promise<void> {
    this.byId.set(record.id, record);
  }

  async get(tenant: string, id: string): Promise<WorkflowStateRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined;
  }

  async listByTeam(tenant: string, teamId: string): Promise<WorkflowStateRecord[]> {
    return [...this.byId.values()]
      .filter((record) => record.tenant === tenant && record.teamId === teamId)
      .sort((a, b) => a.position - b.position);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<WorkflowStateRecord>,
  ): Promise<WorkflowStateRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next: WorkflowStateRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    this.byId.set(id, next);
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    const current = this.byId.get(id);
    if (current && current.tenant === tenant) this.byId.delete(id);
  }
}

interface WorkflowStateRow {
  id: string;
  tenant: string;
  team_id: string;
  name: string;
  description: string | null;
  status: string;
  color: string;
  position: number;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToRecord(row: WorkflowStateRow): WorkflowStateRecord {
  return WorkflowStateRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    teamId: row.team_id,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    status: row.status,
    color: row.color,
    position: row.position,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class PgWorkflowStateStore implements WorkflowStateStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: WorkflowStateRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_workflow_states
         (id, tenant, team_id, name, description, status, color, position, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz)`,
      [
        record.id,
        record.tenant,
        record.teamId,
        record.name,
        record.description ?? null,
        record.status,
        record.color,
        record.position,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async get(tenant: string, id: string): Promise<WorkflowStateRecord | undefined> {
    const { rows } = await this.client.query<WorkflowStateRow>(
      "SELECT * FROM everdict_workflow_states WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async listByTeam(tenant: string, teamId: string): Promise<WorkflowStateRecord[]> {
    const { rows } = await this.client.query<WorkflowStateRow>(
      "SELECT * FROM everdict_workflow_states WHERE tenant=$1 AND team_id=$2 ORDER BY position",
      [tenant, teamId],
    );
    return rows.map(rowToRecord);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<WorkflowStateRecord>,
  ): Promise<WorkflowStateRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: WorkflowStateRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    const { rows } = await this.client.query<WorkflowStateRow>(
      `UPDATE everdict_workflow_states
         SET name=$3, description=$4, status=$5, color=$6, position=$7, updated_at=$8::timestamptz
       WHERE tenant=$1 AND id=$2 RETURNING *`,
      [tenant, id, next.name, next.description ?? null, next.status, next.color, next.position, next.updatedAt],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_workflow_states WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}
