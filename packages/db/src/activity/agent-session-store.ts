import type { AgentSessionStore } from "@everdict/application-control";
import {
  type AgentMessageRecord,
  AgentMessageRecordSchema,
  type AgentPermissionMode,
  type AgentRunStatus,
  type AgentSessionRecord,
  AgentSessionRecordSchema,
  type AgentWakeIntent,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// Arm or clear a record's wake intent by REPLACING it — the field is optional, so clearing means producing a record
// without the key rather than deleting from the object in place.
function withWakeIntent(
  record: AgentSessionRecord,
  intent: AgentWakeIntent | null,
  updatedAt: string,
): AgentSessionRecord {
  const { wakeIntent: _cleared, ...rest } = record;
  return { ...rest, ...(intent === null ? {} : { wakeIntent: intent }), updatedAt };
}

export class InMemoryAgentSessionStore implements AgentSessionStore {
  private readonly sessions: AgentSessionRecord[] = [];
  private readonly messages: AgentMessageRecord[] = [];

  async createSession(record: AgentSessionRecord): Promise<void> {
    this.sessions.push(record);
  }

  async getSession(tenant: string, owner: string, id: string): Promise<AgentSessionRecord | undefined> {
    return this.sessions.find((s) => s.tenant === tenant && s.owner === owner && s.id === id);
  }

  async getVisibleSession(tenant: string, subject: string, id: string): Promise<AgentSessionRecord | undefined> {
    return this.sessions.find(
      (s) => s.tenant === tenant && s.id === id && (s.owner === subject || s.visibility === "workspace"),
    );
  }

  async listSessions(tenant: string, owner: string): Promise<AgentSessionRecord[]> {
    return this.sessions
      .filter((s) => s.tenant === tenant && s.owner === owner)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async touchSession(tenant: string, id: string, updatedAt: string, title?: string): Promise<void> {
    const s = this.sessions.find((r) => r.tenant === tenant && r.id === id);
    if (!s) return;
    s.updatedAt = updatedAt;
    if (title !== undefined) s.title = title;
  }

  async setSessionModel(tenant: string, id: string, model: string | null, updatedAt: string): Promise<void> {
    const s = this.sessions.find((r) => r.tenant === tenant && r.id === id);
    if (!s) return;
    s.updatedAt = updatedAt;
    s.model = model ?? undefined; // null clears the override → falls back to the workspace/server default
  }

  async setSessionPermissionMode(
    tenant: string,
    id: string,
    mode: AgentPermissionMode | null,
    updatedAt: string,
  ): Promise<void> {
    const s = this.sessions.find((r) => r.tenant === tenant && r.id === id);
    if (!s) return;
    s.updatedAt = updatedAt;
    s.permissionMode = mode ?? undefined; // null clears the standing mode → "default" (ask)
  }

  async setSessionMemory(
    tenant: string,
    id: string,
    memory: string,
    throughSeq: number,
    updatedAt: string,
  ): Promise<void> {
    const s = this.sessions.find((r) => r.tenant === tenant && r.id === id);
    if (!s) return;
    s.updatedAt = updatedAt;
    s.memory = memory;
    s.memoryThroughSeq = throughSeq;
  }

  async setSessionStatus(tenant: string, id: string, status: AgentRunStatus, updatedAt: string): Promise<void> {
    const s = this.sessions.find((r) => r.tenant === tenant && r.id === id);
    if (!s) return;
    s.updatedAt = updatedAt;
    s.status = status;
  }

  async setSessionRunId(tenant: string, id: string, runId: string, updatedAt: string): Promise<void> {
    const s = this.sessions.find((r) => r.tenant === tenant && r.id === id);
    if (!s) return;
    s.updatedAt = updatedAt;
    s.runId = runId;
  }

  async setSessionWakeIntent(
    tenant: string,
    id: string,
    intent: AgentWakeIntent | null,
    updatedAt: string,
  ): Promise<void> {
    const index = this.sessions.findIndex((r) => r.tenant === tenant && r.id === id);
    const current = this.sessions[index];
    if (!current) return;
    this.sessions[index] = withWakeIntent(current, intent, updatedAt);
  }

  async claimWakeIntent(tenant: string, id: string, updatedAt: string): Promise<boolean> {
    // Mirrors the Pg claim's "only a row that still has an intent can be cleared" — the caller learns whether it won.
    const index = this.sessions.findIndex((r) => r.tenant === tenant && r.id === id);
    const current = this.sessions[index];
    if (!current || current.wakeIntent === undefined) return false;
    this.sessions[index] = withWakeIntent(current, null, updatedAt);
    return true;
  }

  async listWaitingSessions(tenant: string): Promise<AgentSessionRecord[]> {
    return this.sessions.filter((s) => s.tenant === tenant && s.wakeIntent !== undefined);
  }

  async listExpiredWakeIntents(now: string, opts?: { limit?: number }): Promise<AgentSessionRecord[]> {
    return this.sessions
      .filter((s) => s.wakeIntent !== undefined && s.wakeIntent.deadlineAt <= now)
      .sort((a, b) => (a.wakeIntent?.deadlineAt ?? "").localeCompare(b.wakeIntent?.deadlineAt ?? ""))
      .slice(0, opts?.limit ?? 50);
  }

  async listOrphanedRuns(before: string, opts?: { limit?: number }): Promise<AgentSessionRecord[]> {
    return this.sessions
      .filter((s) => s.status === "running" && s.updatedAt < before)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, opts?.limit ?? 50);
  }

  async claimOrphanedRun(tenant: string, id: string, before: string, updatedAt: string): Promise<boolean> {
    // Mirrors the Pg claim: only a row still "running" AND still stale can be settled, and the caller learns
    // whether it won — a run that settled (or was claimed) in the meantime refuses the claim.
    const s = this.sessions.find((r) => r.tenant === tenant && r.id === id);
    if (!s || s.status !== "running" || !(s.updatedAt < before)) return false;
    s.status = "failed";
    s.updatedAt = updatedAt;
    return true;
  }

  async hasTriggerSession(tenant: string, agentId: string, eventId: string): Promise<boolean> {
    return this.sessions.some(
      (s) => s.tenant === tenant && s.origin?.agentId === agentId && s.origin?.eventId === eventId,
    );
  }

  async findTriggerSession(tenant: string, agentId: string, eventId: string): Promise<AgentSessionRecord | undefined> {
    return this.sessions.find(
      (s) => s.tenant === tenant && s.origin?.agentId === agentId && s.origin?.eventId === eventId,
    );
  }

  async listRuns(tenant: string, opts?: { limit?: number }): Promise<AgentSessionRecord[]> {
    return this.sessions
      .filter((s) => s.tenant === tenant && s.origin !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, opts?.limit ?? 50);
  }

  async deleteSession(tenant: string, owner: string, id: string): Promise<void> {
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i];
      if (s && s.tenant === tenant && s.owner === owner && s.id === id) this.sessions.splice(i, 1);
    }
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m && m.tenant === tenant && m.sessionId === id) this.messages.splice(i, 1);
    }
  }

  async appendMessages(records: AgentMessageRecord[]): Promise<void> {
    this.messages.push(...records);
  }

  async listMessages(tenant: string, sessionId: string, sinceSeq?: number): Promise<AgentMessageRecord[]> {
    return this.messages
      .filter((m) => m.tenant === tenant && m.sessionId === sessionId && (sinceSeq === undefined || m.seq > sinceSeq))
      .sort((a, b) => a.seq - b.seq);
  }
}

interface SessionRow {
  id: string;
  tenant: string;
  owner: string;
  title: string;
  model: string | null;
  permission_mode: string | null;
  memory: string | null;
  memory_through_seq: number | null;
  visibility: string | null;
  origin: unknown;
  status: string | null;
  run_id: string | null;
  wake_intent: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

const SESSION_COLUMNS =
  "id, tenant, owner, title, model, permission_mode, memory, memory_through_seq, visibility, origin, status, run_id, wake_intent, created_at, updated_at";

function sessionRowToRecord(row: SessionRow): AgentSessionRecord {
  return AgentSessionRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    owner: row.owner,
    title: row.title,
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.permission_mode !== null ? { permissionMode: row.permission_mode } : {}),
    ...(row.memory !== null ? { memory: row.memory } : {}),
    ...(row.memory_through_seq !== null ? { memoryThroughSeq: Number(row.memory_through_seq) } : {}),
    ...(row.visibility !== null ? { visibility: row.visibility } : {}),
    ...(row.origin !== null && row.origin !== undefined ? { origin: row.origin } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.wake_intent !== null && row.wake_intent !== undefined ? { wakeIntent: row.wake_intent } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

interface MessageRow {
  id: string;
  tenant: string;
  session_id: string;
  seq: number;
  role: string;
  content: string;
  reasoning: string | null;
  tool_calls: unknown;
  tool_call_id: string | null;
  name: string | null;
  refs: unknown;
  attachments: unknown;
  created_at: string | Date;
}

function messageRowToRecord(row: MessageRow): AgentMessageRecord {
  return AgentMessageRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    sessionId: row.session_id,
    seq: Number(row.seq),
    role: row.role,
    content: row.content,
    ...(row.reasoning !== null ? { reasoning: row.reasoning } : {}),
    ...(Array.isArray(row.tool_calls) ? { toolCalls: row.tool_calls } : {}),
    ...(row.tool_call_id !== null ? { toolCallId: row.tool_call_id } : {}),
    ...(row.name !== null ? { name: row.name } : {}),
    ...(Array.isArray(row.refs) ? { references: row.refs } : {}),
    ...(Array.isArray(row.attachments) ? { attachments: row.attachments } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  });
}

export class PgAgentSessionStore implements AgentSessionStore {
  constructor(private readonly client: SqlClient) {}

  async createSession(record: AgentSessionRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_agent_sessions (id, tenant, owner, title, model, permission_mode, visibility, origin, status, run_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        record.id,
        record.tenant,
        record.owner,
        record.title,
        record.model ?? null,
        record.permissionMode ?? null,
        record.visibility ?? null,
        record.origin !== undefined ? JSON.stringify(record.origin) : null,
        record.status ?? null,
        record.runId ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async getSession(tenant: string, owner: string, id: string): Promise<AgentSessionRecord | undefined> {
    const res = await this.client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM everdict_agent_sessions WHERE tenant = $1 AND owner = $2 AND id = $3`,
      [tenant, owner, id],
    );
    return res.rows[0] ? sessionRowToRecord(res.rows[0]) : undefined;
  }

  async getVisibleSession(tenant: string, subject: string, id: string): Promise<AgentSessionRecord | undefined> {
    const res = await this.client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM everdict_agent_sessions WHERE tenant = $1 AND id = $2 AND (owner = $3 OR visibility = 'workspace')`,
      [tenant, id, subject],
    );
    return res.rows[0] ? sessionRowToRecord(res.rows[0]) : undefined;
  }

  async listSessions(tenant: string, owner: string): Promise<AgentSessionRecord[]> {
    const res = await this.client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM everdict_agent_sessions WHERE tenant = $1 AND owner = $2
       ORDER BY updated_at DESC, id DESC`,
      [tenant, owner],
    );
    return res.rows.map(sessionRowToRecord);
  }

  async touchSession(tenant: string, id: string, updatedAt: string, title?: string): Promise<void> {
    if (title !== undefined) {
      await this.client.query(
        "UPDATE everdict_agent_sessions SET updated_at = $3, title = $4 WHERE tenant = $1 AND id = $2",
        [tenant, id, updatedAt, title],
      );
      return;
    }
    await this.client.query("UPDATE everdict_agent_sessions SET updated_at = $3 WHERE tenant = $1 AND id = $2", [
      tenant,
      id,
      updatedAt,
    ]);
  }

  async setSessionModel(tenant: string, id: string, model: string | null, updatedAt: string): Promise<void> {
    await this.client.query(
      "UPDATE everdict_agent_sessions SET model = $3, updated_at = $4 WHERE tenant = $1 AND id = $2",
      [tenant, id, model, updatedAt],
    );
  }

  async setSessionPermissionMode(
    tenant: string,
    id: string,
    mode: AgentPermissionMode | null,
    updatedAt: string,
  ): Promise<void> {
    await this.client.query(
      "UPDATE everdict_agent_sessions SET permission_mode = $3, updated_at = $4 WHERE tenant = $1 AND id = $2",
      [tenant, id, mode, updatedAt],
    );
  }

  async setSessionMemory(
    tenant: string,
    id: string,
    memory: string,
    throughSeq: number,
    updatedAt: string,
  ): Promise<void> {
    await this.client.query(
      "UPDATE everdict_agent_sessions SET memory = $3, memory_through_seq = $4, updated_at = $5 WHERE tenant = $1 AND id = $2",
      [tenant, id, memory, throughSeq, updatedAt],
    );
  }

  async setSessionStatus(tenant: string, id: string, status: AgentRunStatus, updatedAt: string): Promise<void> {
    await this.client.query(
      "UPDATE everdict_agent_sessions SET status = $3, updated_at = $4 WHERE tenant = $1 AND id = $2",
      [tenant, id, status, updatedAt],
    );
  }

  async setSessionRunId(tenant: string, id: string, runId: string, updatedAt: string): Promise<void> {
    await this.client.query(
      "UPDATE everdict_agent_sessions SET run_id = $3, updated_at = $4 WHERE tenant = $1 AND id = $2",
      [tenant, id, runId, updatedAt],
    );
  }

  async setSessionWakeIntent(
    tenant: string,
    id: string,
    intent: AgentWakeIntent | null,
    updatedAt: string,
  ): Promise<void> {
    await this.client.query(
      "UPDATE everdict_agent_sessions SET wake_intent = $3, updated_at = $4 WHERE tenant = $1 AND id = $2",
      [tenant, id, intent === null ? null : JSON.stringify(intent), updatedAt],
    );
  }

  async claimWakeIntent(tenant: string, id: string, updatedAt: string): Promise<boolean> {
    // The claim IS the WHERE clause: only a row that still has an intent can be cleared, and RETURNING tells the
    // caller whether it won. Two resumers racing the same session therefore produce exactly one resumed turn.
    const res = await this.client.query<{ id: string }>(
      `UPDATE everdict_agent_sessions SET wake_intent = NULL, updated_at = $3
       WHERE tenant = $1 AND id = $2 AND wake_intent IS NOT NULL
       RETURNING id`,
      [tenant, id, updatedAt],
    );
    return res.rows.length > 0;
  }

  async listWaitingSessions(tenant: string): Promise<AgentSessionRecord[]> {
    const res = await this.client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM everdict_agent_sessions WHERE tenant = $1 AND wake_intent IS NOT NULL
       ORDER BY updated_at DESC, id DESC`,
      [tenant],
    );
    return res.rows.map(sessionRowToRecord);
  }

  async listExpiredWakeIntents(now: string, opts?: { limit?: number }): Promise<AgentSessionRecord[]> {
    // Cross-tenant on purpose: the sweep is an operator-side reaper, not a workspace read. Ordered by deadline so a
    // backlog drains oldest-first, and bounded so one pass can never fan out unboundedly.
    const res = await this.client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM everdict_agent_sessions
       WHERE wake_intent IS NOT NULL AND wake_intent->>'deadlineAt' <= $1
       ORDER BY wake_intent->>'deadlineAt' ASC
       LIMIT $2`,
      [now, opts?.limit ?? 50],
    );
    return res.rows.map(sessionRowToRecord);
  }

  async listOrphanedRuns(before: string, opts?: { limit?: number }): Promise<AgentSessionRecord[]> {
    // Cross-tenant on purpose (like listExpiredWakeIntents): the sweep is an operator-side reaper. Oldest
    // first so a backlog drains in strand order; bounded so one pass never fans out unboundedly.
    const res = await this.client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM everdict_agent_sessions
       WHERE status = 'running' AND updated_at < $1
       ORDER BY updated_at ASC
       LIMIT $2`,
      [before, opts?.limit ?? 50],
    );
    return res.rows.map(sessionRowToRecord);
  }

  async claimOrphanedRun(tenant: string, id: string, before: string, updatedAt: string): Promise<boolean> {
    // The claim IS the WHERE clause (claimWakeIntent's shape): only a row still stranded can be settled, and
    // RETURNING tells the caller whether it won — two sweepers racing the same orphan settle it exactly once.
    const res = await this.client.query<{ id: string }>(
      `UPDATE everdict_agent_sessions SET status = 'failed', updated_at = $4
       WHERE tenant = $1 AND id = $2 AND status = 'running' AND updated_at < $3
       RETURNING id`,
      [tenant, id, before, updatedAt],
    );
    return res.rows.length > 0;
  }

  async hasTriggerSession(tenant: string, agentId: string, eventId: string): Promise<boolean> {
    return (await this.findTriggerSession(tenant, agentId, eventId)) !== undefined;
  }

  async findTriggerSession(tenant: string, agentId: string, eventId: string): Promise<AgentSessionRecord | undefined> {
    const res = await this.client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM everdict_agent_sessions
       WHERE tenant = $1 AND origin->>'agentId' = $2 AND origin->>'eventId' = $3 LIMIT 1`,
      [tenant, agentId, eventId],
    );
    const row = res.rows[0];
    return row ? sessionRowToRecord(row) : undefined;
  }

  async listRuns(tenant: string, opts?: { limit?: number }): Promise<AgentSessionRecord[]> {
    const res = await this.client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM everdict_agent_sessions WHERE tenant = $1 AND origin IS NOT NULL
       ORDER BY updated_at DESC, id DESC LIMIT $2`,
      [tenant, opts?.limit ?? 50],
    );
    return res.rows.map(sessionRowToRecord);
  }

  async deleteSession(tenant: string, owner: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_agent_messages WHERE tenant = $1 AND session_id = $2", [tenant, id]);
    await this.client.query("DELETE FROM everdict_agent_sessions WHERE tenant = $1 AND owner = $2 AND id = $3", [
      tenant,
      owner,
      id,
    ]);
  }

  async appendMessages(records: AgentMessageRecord[]): Promise<void> {
    for (const record of records) {
      await this.client.query(
        `INSERT INTO everdict_agent_messages (id, tenant, session_id, seq, role, content, reasoning, tool_calls, tool_call_id, name, refs, attachments, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          record.id,
          record.tenant,
          record.sessionId,
          record.seq,
          record.role,
          record.content,
          record.reasoning ?? null,
          record.toolCalls ? JSON.stringify(record.toolCalls) : null,
          record.toolCallId ?? null,
          record.name ?? null,
          record.references ? JSON.stringify(record.references) : null,
          record.attachments ? JSON.stringify(record.attachments) : null,
          record.createdAt,
        ],
      );
    }
  }

  async listMessages(tenant: string, sessionId: string, sinceSeq?: number): Promise<AgentMessageRecord[]> {
    if (sinceSeq !== undefined) {
      const res = await this.client.query<MessageRow>(
        `SELECT id, tenant, session_id, seq, role, content, reasoning, tool_calls, tool_call_id, name, refs, attachments, created_at
         FROM everdict_agent_messages WHERE tenant = $1 AND session_id = $2 AND seq > $3
         ORDER BY seq ASC`,
        [tenant, sessionId, sinceSeq],
      );
      return res.rows.map(messageRowToRecord);
    }
    const res = await this.client.query<MessageRow>(
      `SELECT id, tenant, session_id, seq, role, content, reasoning, tool_calls, tool_call_id, name, refs, attachments, created_at
       FROM everdict_agent_messages WHERE tenant = $1 AND session_id = $2
       ORDER BY seq ASC`,
      [tenant, sessionId],
    );
    return res.rows.map(messageRowToRecord);
  }
}
