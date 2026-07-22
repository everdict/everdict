import type { AgentSessionStore } from "@everdict/application-control";
import {
  type AgentMessageRecord,
  AgentMessageRecordSchema,
  type AgentSessionRecord,
  AgentSessionRecordSchema,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";

export class InMemoryAgentSessionStore implements AgentSessionStore {
  private readonly sessions: AgentSessionRecord[] = [];
  private readonly messages: AgentMessageRecord[] = [];

  async createSession(record: AgentSessionRecord): Promise<void> {
    this.sessions.push(record);
  }

  async getSession(tenant: string, owner: string, id: string): Promise<AgentSessionRecord | undefined> {
    return this.sessions.find((s) => s.tenant === tenant && s.owner === owner && s.id === id);
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
  created_at: string | Date;
  updated_at: string | Date;
}

function sessionRowToRecord(row: SessionRow): AgentSessionRecord {
  return AgentSessionRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    owner: row.owner,
    title: row.title,
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
  tool_calls: unknown;
  tool_call_id: string | null;
  name: string | null;
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
    ...(Array.isArray(row.tool_calls) ? { toolCalls: row.tool_calls } : {}),
    ...(row.tool_call_id !== null ? { toolCallId: row.tool_call_id } : {}),
    ...(row.name !== null ? { name: row.name } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  });
}

export class PgAgentSessionStore implements AgentSessionStore {
  constructor(private readonly client: SqlClient) {}

  async createSession(record: AgentSessionRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_agent_sessions (id, tenant, owner, title, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [record.id, record.tenant, record.owner, record.title, record.createdAt, record.updatedAt],
    );
  }

  async getSession(tenant: string, owner: string, id: string): Promise<AgentSessionRecord | undefined> {
    const res = await this.client.query<SessionRow>(
      `SELECT id, tenant, owner, title, created_at, updated_at
       FROM everdict_agent_sessions WHERE tenant = $1 AND owner = $2 AND id = $3`,
      [tenant, owner, id],
    );
    return res.rows[0] ? sessionRowToRecord(res.rows[0]) : undefined;
  }

  async listSessions(tenant: string, owner: string): Promise<AgentSessionRecord[]> {
    const res = await this.client.query<SessionRow>(
      `SELECT id, tenant, owner, title, created_at, updated_at
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
        `INSERT INTO everdict_agent_messages (id, tenant, session_id, seq, role, content, tool_calls, tool_call_id, name, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          record.id,
          record.tenant,
          record.sessionId,
          record.seq,
          record.role,
          record.content,
          record.toolCalls ? JSON.stringify(record.toolCalls) : null,
          record.toolCallId ?? null,
          record.name ?? null,
          record.createdAt,
        ],
      );
    }
  }

  async listMessages(tenant: string, sessionId: string, sinceSeq?: number): Promise<AgentMessageRecord[]> {
    if (sinceSeq !== undefined) {
      const res = await this.client.query<MessageRow>(
        `SELECT id, tenant, session_id, seq, role, content, tool_calls, tool_call_id, name, created_at
         FROM everdict_agent_messages WHERE tenant = $1 AND session_id = $2 AND seq > $3
         ORDER BY seq ASC`,
        [tenant, sessionId, sinceSeq],
      );
      return res.rows.map(messageRowToRecord);
    }
    const res = await this.client.query<MessageRow>(
      `SELECT id, tenant, session_id, seq, role, content, tool_calls, tool_call_id, name, created_at
       FROM everdict_agent_messages WHERE tenant = $1 AND session_id = $2
       ORDER BY seq ASC`,
      [tenant, sessionId],
    );
    return res.rows.map(messageRowToRecord);
  }
}
