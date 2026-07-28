import { type CommentRecord, CommentRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

import type { CommentStore, CommentUpdatePatch } from "@everdict/application-control";

export class InMemoryCommentStore implements CommentStore {
  private readonly rows: CommentRecord[] = [];

  async add(record: CommentRecord): Promise<void> {
    this.rows.push(record);
  }

  async list(tenant: string, resourceType: string, resourceId: string): Promise<CommentRecord[]> {
    return this.rows
      .filter((r) => r.tenant === tenant && r.resourceType === resourceType && r.resourceId === resourceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(tenant: string, id: string): Promise<CommentRecord | undefined> {
    return this.rows.find((r) => r.tenant === tenant && r.id === id);
  }

  async update(tenant: string, id: string, patch: CommentUpdatePatch, updatedAt: string): Promise<void> {
    const i = this.rows.findIndex((r) => r.tenant === tenant && r.id === id);
    const row = this.rows[i];
    if (!row) return;
    // Rebuild instead of mutating so `agentActivity: null` can drop the key (matching the Pg NULL) without `delete`.
    const { agentActivity: currentActivity, ...rest } = row;
    const nextActivity = patch.agentActivity === undefined ? currentActivity : (patch.agentActivity ?? undefined);
    this.rows[i] = {
      ...rest,
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.agentStatus !== undefined ? { agentStatus: patch.agentStatus } : {}),
      ...(nextActivity !== undefined ? { agentActivity: nextActivity } : {}),
      updatedAt,
    };
  }

  async listStuckAgentAnswers(updatedBefore: string): Promise<CommentRecord[]> {
    return this.rows.filter(
      (r) => (r.agentStatus === "running" || r.agentStatus === "awaiting_approval") && r.updatedAt < updatedBefore,
    );
  }

  async remove(tenant: string, id: string): Promise<void> {
    // Delete itself + the replies (children) on this comment together (prevents orphaned replies).
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i];
      if (r && r.tenant === tenant && (r.id === id || r.parentId === id)) this.rows.splice(i, 1);
    }
  }
}

interface CommentRow {
  id: string;
  tenant: string;
  resource_type: string;
  resource_id: string;
  parent_id: string | null;
  author: string;
  body: string;
  author_kind: string | null;
  agent_status: string | null;
  agent_activity: string | null;
  agent_session_id: string | null;
  agent_asked_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const COMMENT_COLUMNS =
  "id, tenant, resource_type, resource_id, parent_id, author, body, author_kind, agent_status, agent_activity, agent_session_id, agent_asked_by, created_at, updated_at";

function rowToRecord(row: CommentRow): CommentRecord {
  return CommentRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    ...(row.parent_id !== null ? { parentId: row.parent_id } : {}),
    author: row.author,
    body: row.body,
    ...(row.author_kind !== null ? { authorKind: row.author_kind } : {}),
    ...(row.agent_status !== null ? { agentStatus: row.agent_status } : {}),
    ...(row.agent_activity !== null ? { agentActivity: row.agent_activity } : {}),
    ...(row.agent_session_id !== null ? { agentSessionId: row.agent_session_id } : {}),
    ...(row.agent_asked_by !== null ? { agentAskedBy: row.agent_asked_by } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

export class PgCommentStore implements CommentStore {
  constructor(private readonly client: SqlClient) {}

  async add(record: CommentRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_comments (id, tenant, resource_type, resource_id, parent_id, author, body, author_kind, agent_status, agent_activity, agent_session_id, agent_asked_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        record.id,
        record.tenant,
        record.resourceType,
        record.resourceId,
        record.parentId ?? null,
        record.author,
        record.body,
        record.authorKind ?? null,
        record.agentStatus ?? null,
        record.agentActivity ?? null,
        record.agentSessionId ?? null,
        record.agentAskedBy ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async list(tenant: string, resourceType: string, resourceId: string): Promise<CommentRecord[]> {
    const res = await this.client.query<CommentRow>(
      `SELECT ${COMMENT_COLUMNS}
       FROM everdict_comments WHERE tenant = $1 AND resource_type = $2 AND resource_id = $3
       ORDER BY created_at ASC, id ASC`,
      [tenant, resourceType, resourceId],
    );
    return res.rows.map(rowToRecord);
  }

  async get(tenant: string, id: string): Promise<CommentRecord | undefined> {
    const res = await this.client.query<CommentRow>(
      `SELECT ${COMMENT_COLUMNS}
       FROM everdict_comments WHERE tenant = $1 AND id = $2`,
      [tenant, id],
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async update(tenant: string, id: string, patch: CommentUpdatePatch, updatedAt: string): Promise<void> {
    // Only the provided keys are patched (dynamic SET) — an absent key keeps the stored value.
    const sets: string[] = [];
    const params: unknown[] = [tenant, id];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.body !== undefined) push("body", patch.body);
    if (patch.agentStatus !== undefined) push("agent_status", patch.agentStatus);
    if (patch.agentActivity !== undefined) push("agent_activity", patch.agentActivity); // null clears
    push("updated_at", updatedAt);
    await this.client.query(`UPDATE everdict_comments SET ${sets.join(", ")} WHERE tenant = $1 AND id = $2`, params);
  }

  async listStuckAgentAnswers(updatedBefore: string): Promise<CommentRecord[]> {
    const res = await this.client.query<CommentRow>(
      `SELECT ${COMMENT_COLUMNS}
       FROM everdict_comments
       WHERE agent_status IN ('running', 'awaiting_approval') AND updated_at < $1
       ORDER BY updated_at ASC`,
      [updatedBefore],
    );
    return res.rows.map(rowToRecord);
  }

  async remove(tenant: string, id: string): Promise<void> {
    // Delete itself + the replies (parent_id = id) together (prevents orphans).
    await this.client.query("DELETE FROM everdict_comments WHERE tenant = $1 AND (id = $2 OR parent_id = $2)", [
      tenant,
      id,
    ]);
  }
}
