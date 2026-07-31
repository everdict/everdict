import type { AgentTaskStore } from "@everdict/application-control";
import { type AgentTaskRecord, AgentTaskRecordSchema, type AgentTaskStatus } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

export class InMemoryAgentTaskStore implements AgentTaskStore {
  private readonly tasks: AgentTaskRecord[] = [];

  async create(record: AgentTaskRecord): Promise<void> {
    this.tasks.push(record);
  }

  async get(tenant: string, id: string): Promise<AgentTaskRecord | undefined> {
    return this.tasks.find((t) => t.tenant === tenant && t.id === id);
  }

  async list(tenant: string, opts?: { status?: AgentTaskStatus; limit?: number }): Promise<AgentTaskRecord[]> {
    return this.tasks
      .filter((t) => t.tenant === tenant && (opts?.status === undefined || t.status === opts.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, opts?.limit ?? 200);
  }

  async update(tenant: string, id: string, patch: Partial<AgentTaskRecord>): Promise<AgentTaskRecord | undefined> {
    const index = this.tasks.findIndex((t) => t.tenant === tenant && t.id === id);
    const existing = this.tasks[index];
    if (index < 0 || !existing) return undefined;
    const updated = { ...existing, ...patch };
    this.tasks[index] = updated;
    return updated;
  }

  async remove(tenant: string, id: string): Promise<void> {
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      const t = this.tasks[i];
      if (t && t.tenant === tenant && t.id === id) this.tasks.splice(i, 1);
    }
  }
}

interface TaskRow {
  id: string;
  tenant: string;
  subject: string;
  description: string | null;
  status: string;
  owner: string | null;
  blocked_by: unknown;
  created_by: string;
  origin: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

const TASK_COLUMNS =
  "id, tenant, subject, description, status, owner, blocked_by, created_by, origin, created_at, updated_at";

function taskRowToRecord(row: TaskRow): AgentTaskRecord {
  return AgentTaskRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    subject: row.subject,
    ...(row.description !== null ? { description: row.description } : {}),
    status: row.status,
    ...(row.owner !== null ? { owner: row.owner } : {}),
    blockedBy: Array.isArray(row.blocked_by) ? row.blocked_by : [],
    createdBy: row.created_by,
    ...(row.origin !== null && row.origin !== undefined ? { origin: row.origin } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

export class PgAgentTaskStore implements AgentTaskStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: AgentTaskRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_agent_tasks (id, tenant, subject, description, status, owner, blocked_by, created_by, origin, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        record.id,
        record.tenant,
        record.subject,
        record.description ?? null,
        record.status,
        record.owner ?? null,
        JSON.stringify(record.blockedBy),
        record.createdBy,
        record.origin !== undefined ? JSON.stringify(record.origin) : null,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async get(tenant: string, id: string): Promise<AgentTaskRecord | undefined> {
    const res = await this.client.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM everdict_agent_tasks WHERE tenant = $1 AND id = $2`,
      [tenant, id],
    );
    return res.rows[0] ? taskRowToRecord(res.rows[0]) : undefined;
  }

  async list(tenant: string, opts?: { status?: AgentTaskStatus; limit?: number }): Promise<AgentTaskRecord[]> {
    if (opts?.status !== undefined) {
      const res = await this.client.query<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM everdict_agent_tasks WHERE tenant = $1 AND status = $2
         ORDER BY updated_at DESC, id DESC LIMIT $3`,
        [tenant, opts.status, opts.limit ?? 200],
      );
      return res.rows.map(taskRowToRecord);
    }
    const res = await this.client.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM everdict_agent_tasks WHERE tenant = $1
       ORDER BY updated_at DESC, id DESC LIMIT $2`,
      [tenant, opts?.limit ?? 200],
    );
    return res.rows.map(taskRowToRecord);
  }

  async update(tenant: string, id: string, patch: Partial<AgentTaskRecord>): Promise<AgentTaskRecord | undefined> {
    // Fetch-merge-write (same pattern as the other small stores): task updates are low-contention and the
    // service already read the record for transition detection.
    const existing = await this.get(tenant, id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    await this.client.query(
      `UPDATE everdict_agent_tasks
       SET subject = $3, description = $4, status = $5, owner = $6, blocked_by = $7, updated_at = $8
       WHERE tenant = $1 AND id = $2`,
      [
        tenant,
        id,
        updated.subject,
        updated.description ?? null,
        updated.status,
        updated.owner ?? null,
        JSON.stringify(updated.blockedBy),
        updated.updatedAt,
      ],
    );
    return updated;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_agent_tasks WHERE tenant = $1 AND id = $2", [tenant, id]);
  }
}
