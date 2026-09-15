import type { WorkflowStateStore } from "@everdict/application-control";
import { type WorkflowStateRecord, WorkflowStateRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { iso } from "./row.js";

// A workspace's named workflow states — same contract in-memory and on Postgres. Always ordered by `position`: the
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

  async listByTenant(tenant: string): Promise<WorkflowStateRecord[]> {
    return [...this.byId.values()].filter((record) => record.tenant === tenant).sort((a, b) => a.position - b.position);
  }
}

interface WorkflowStateRow {
  id: string;
  tenant: string;
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
         (id, tenant, name, description, status, color, position, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz)`,
      [
        record.id,
        record.tenant,
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

  async listByTenant(tenant: string): Promise<WorkflowStateRecord[]> {
    const { rows } = await this.client.query<WorkflowStateRow>(
      "SELECT * FROM everdict_workflow_states WHERE tenant=$1 ORDER BY position",
      [tenant],
    );
    return rows.map(rowToRecord);
  }
}
