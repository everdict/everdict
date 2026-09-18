import type { AgentSessionStore } from "@everdict/application-control";
import {
  type AgentInboxAppend,
  type AgentInboxEntry,
  AgentInboxEntrySchema,
  type AgentMessageRecord,
  AgentMessageRecordSchema,
  type AgentPermissionMode,
  type AgentRunStatus,
  type AgentSessionRecord,
  AgentSessionRecordSchema,
  type AgentTeammateConfig,
  type AgentWakeIntent,
  InternalError,
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
  // The steering log. Monotonic across the store like the Postgres BIGSERIAL, so the two twins order a
  // session's instructions the same way.
  private readonly inbox: AgentInboxEntry[] = [];
  private inboxSeq = 0;

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

  async setSessionTeammate(
    tenant: string,
    id: string,
    config: AgentTeammateConfig | null,
    updatedAt: string,
  ): Promise<void> {
    const index = this.sessions.findIndex((r) => r.tenant === tenant && r.id === id);
    const current = this.sessions[index];
    if (!current) return;
    const { teammate: _cleared, ...rest } = current;
    this.sessions[index] = { ...rest, ...(config === null ? {} : { teammate: config }), updatedAt };
  }

  async setSessionPermissionRules(
    tenant: string,
    id: string,
    rules: Record<string, "allow" | "deny">,
    updatedAt: string,
  ): Promise<void> {
    const s = this.sessions.find((r) => r.tenant === tenant && r.id === id);
    if (!s) return;
    s.updatedAt = updatedAt;
    s.permissionRules = rules;
  }

  async setSessionPlan(
    tenant: string,
    id: string,
    plan: { content: string; approvedAt: string } | null,
    updatedAt: string,
  ): Promise<void> {
    const index = this.sessions.findIndex((r) => r.tenant === tenant && r.id === id);
    const current = this.sessions[index];
    if (!current) return;
    const { plan: _cleared, ...rest } = current;
    this.sessions[index] = { ...rest, ...(plan === null ? {} : { plan }), updatedAt };
  }

  async listTeammateSessions(opts?: { limit?: number }): Promise<AgentSessionRecord[]> {
    return this.sessions.filter((s) => s.teammate !== undefined).slice(0, opts?.limit ?? 200);
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
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      const e = this.inbox[i];
      if (e && e.tenant === tenant && e.sessionId === id) this.inbox.splice(i, 1);
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

  async appendInbox(entry: AgentInboxAppend, at: string): Promise<AgentInboxEntry> {
    this.inboxSeq += 1;
    const stored: AgentInboxEntry = {
      id: crypto.randomUUID(),
      tenant: entry.tenant,
      sessionId: entry.sessionId,
      seq: this.inboxSeq,
      from: entry.from,
      ...(entry.sender !== undefined ? { sender: entry.sender } : {}),
      content: entry.content,
      at,
      delivery: { state: "queued" },
    };
    this.inbox.push(stored);
    return { ...stored };
  }

  async claimInbox(tenant: string, sessionId: string, at: string): Promise<AgentInboxEntry[]> {
    return this.settleInbox(tenant, sessionId, "delivered", at);
  }

  async discardInbox(tenant: string, sessionId: string, at: string): Promise<AgentInboxEntry[]> {
    return this.settleInbox(tenant, sessionId, "discarded", at);
  }

  async listQueuedInboxSessions(opts?: { limit?: number }): Promise<
    { tenant: string; sessionId: string; queued: number }[]
  > {
    const counts = new Map<string, { tenant: string; sessionId: string; queued: number }>();
    for (const entry of this.inbox) {
      if (entry.delivery.state !== "queued") continue;
      const key = `${entry.tenant}:${entry.sessionId}`;
      const seen = counts.get(key);
      if (seen) seen.queued += 1;
      else counts.set(key, { tenant: entry.tenant, sessionId: entry.sessionId, queued: 1 });
    }
    return [...counts.values()].slice(0, opts?.limit ?? 500);
  }

  // The claim and the discard are ONE operation with two endings, for the same reason the Postgres twin runs
  // one conditional UPDATE: whatever takes the queued rows must take all of them, in seq order, and leave
  // nothing a second caller could take again. Scoped by tenant AND session — the twin that ignores the tenant
  // is more permissive than production on the one axis where that is worst (rule `testing`).
  private settleInbox(
    tenant: string,
    sessionId: string,
    state: "delivered" | "discarded",
    at: string,
  ): AgentInboxEntry[] {
    const taken = this.inbox
      .filter((e) => e.tenant === tenant && e.sessionId === sessionId && e.delivery.state === "queued")
      .sort((a, b) => a.seq - b.seq);
    for (const entry of taken) entry.delivery = { state, at };
    return taken.map((entry) => ({ ...entry }));
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
  teammate: unknown;
  permission_rules: unknown;
  plan: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

const SESSION_COLUMNS =
  "id, tenant, owner, title, model, permission_mode, memory, memory_through_seq, visibility, origin, status, run_id, wake_intent, teammate, permission_rules, plan, created_at, updated_at";

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
    ...(row.teammate !== null && row.teammate !== undefined ? { teammate: row.teammate } : {}),
    ...(row.permission_rules !== null && row.permission_rules !== undefined
      ? { permissionRules: row.permission_rules }
      : {}),
    ...(row.plan !== null && row.plan !== undefined ? { plan: row.plan } : {}),
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
  is_error: boolean | null;
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
    ...(row.is_error !== null ? { isError: row.is_error } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  });
}

// ── THE STEERING LOG'S ROW ────────────────────────────────────────────────────────────────────────────
interface InboxRow {
  id: string;
  seq: string | number; // bigserial — pg returns bigint as a string
  tenant: string;
  session_id: string;
  source: string;
  sender: string | null;
  content: string;
  created_at: string | Date;
  disposition: string;
  settled_at: string | Date | null;
}

function inboxRowToEntry(row: InboxRow): AgentInboxEntry {
  // The delivery state is PARSED from the pair the row holds, and a settled row with no timestamp is a
  // refusal rather than a silent `queued`: the union's whole purpose is that "taken back" and "still
  // waiting" cannot render as each other.
  const settledAt = row.settled_at === null ? undefined : new Date(row.settled_at).toISOString();
  const delivery = row.disposition === "queued" ? { state: "queued" } : { state: row.disposition, at: settledAt };
  return AgentInboxEntrySchema.parse({
    id: row.id,
    tenant: row.tenant,
    sessionId: row.session_id,
    seq: Number(row.seq),
    from: row.source,
    ...(row.sender !== null ? { sender: row.sender } : {}),
    content: row.content,
    at: new Date(row.created_at).toISOString(),
    delivery,
  });
}

const INBOX_COLUMNS = "id, seq, tenant, session_id, source, sender, content, created_at, disposition, settled_at";

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

  async setSessionTeammate(
    tenant: string,
    id: string,
    config: AgentTeammateConfig | null,
    updatedAt: string,
  ): Promise<void> {
    await this.client.query(
      "UPDATE everdict_agent_sessions SET teammate = $3, updated_at = $4 WHERE tenant = $1 AND id = $2",
      [tenant, id, config === null ? null : JSON.stringify(config), updatedAt],
    );
  }

  async setSessionPermissionRules(
    tenant: string,
    id: string,
    rules: Record<string, "allow" | "deny">,
    updatedAt: string,
  ): Promise<void> {
    await this.client.query(
      "UPDATE everdict_agent_sessions SET permission_rules = $3, updated_at = $4 WHERE tenant = $1 AND id = $2",
      [tenant, id, JSON.stringify(rules), updatedAt],
    );
  }

  async setSessionPlan(
    tenant: string,
    id: string,
    plan: { content: string; approvedAt: string } | null,
    updatedAt: string,
  ): Promise<void> {
    await this.client.query(
      "UPDATE everdict_agent_sessions SET plan = $3, updated_at = $4 WHERE tenant = $1 AND id = $2",
      [tenant, id, plan === null ? null : JSON.stringify(plan), updatedAt],
    );
  }

  async listTeammateSessions(opts?: { limit?: number }): Promise<AgentSessionRecord[]> {
    // Cross-tenant on purpose: the boot restore is an operator-side scan (one row per standing teammate).
    const res = await this.client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM everdict_agent_sessions WHERE teammate IS NOT NULL
       ORDER BY updated_at DESC, id DESC LIMIT $1`,
      [opts?.limit ?? 200],
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
    // The steering log goes with the conversation it addressed: a queued instruction for a deleted session
    // would otherwise keep that session in the boot read forever, waking nothing.
    await this.client.query("DELETE FROM everdict_agent_inbox WHERE tenant = $1 AND session_id = $2", [tenant, id]);
    await this.client.query("DELETE FROM everdict_agent_sessions WHERE tenant = $1 AND owner = $2 AND id = $3", [
      tenant,
      owner,
      id,
    ]);
  }

  async appendMessages(records: AgentMessageRecord[]): Promise<void> {
    for (const record of records) {
      await this.client.query(
        `INSERT INTO everdict_agent_messages (id, tenant, session_id, seq, role, content, reasoning, tool_calls, tool_call_id, name, refs, attachments, is_error, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
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
          record.isError ?? null,
          record.createdAt,
        ],
      );
    }
  }

  async listMessages(tenant: string, sessionId: string, sinceSeq?: number): Promise<AgentMessageRecord[]> {
    if (sinceSeq !== undefined) {
      const res = await this.client.query<MessageRow>(
        `SELECT id, tenant, session_id, seq, role, content, reasoning, tool_calls, tool_call_id, name, refs, attachments, is_error, created_at
         FROM everdict_agent_messages WHERE tenant = $1 AND session_id = $2 AND seq > $3
         ORDER BY seq ASC`,
        [tenant, sessionId, sinceSeq],
      );
      return res.rows.map(messageRowToRecord);
    }
    const res = await this.client.query<MessageRow>(
      `SELECT id, tenant, session_id, seq, role, content, reasoning, tool_calls, tool_call_id, name, refs, attachments, is_error, created_at
       FROM everdict_agent_messages WHERE tenant = $1 AND session_id = $2
       ORDER BY seq ASC`,
      [tenant, sessionId],
    );
    return res.rows.map(messageRowToRecord);
  }
  async appendInbox(entry: AgentInboxAppend, at: string): Promise<AgentInboxEntry> {
    // RETURNING, not a bare INSERT: the caller is about to answer a member "queued", and it may only do so
    // on the strength of a row the store says exists (protocol L1). The seq it hands back is also the
    // ordering token — a sender holding it before sending the next instruction has "X before Y" as a fact.
    const res = await this.client.query<InboxRow>(
      `INSERT INTO everdict_agent_inbox (id, tenant, session_id, source, sender, content, created_at, disposition)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued')
       RETURNING ${INBOX_COLUMNS}`,
      [crypto.randomUUID(), entry.tenant, entry.sessionId, entry.from, entry.sender ?? null, entry.content, at],
    );
    const row = res.rows[0];
    if (!row)
      throw new InternalError(
        "UPSTREAM_ERROR",
        { sessionId: entry.sessionId },
        "the steering message was not stored — refusing to report it as queued.",
      );
    return inboxRowToEntry(row);
  }

  async claimInbox(tenant: string, sessionId: string, at: string): Promise<AgentInboxEntry[]> {
    return this.settleInbox(tenant, sessionId, "delivered", at);
  }

  async discardInbox(tenant: string, sessionId: string, at: string): Promise<AgentInboxEntry[]> {
    return this.settleInbox(tenant, sessionId, "discarded", at);
  }

  async listQueuedInboxSessions(opts?: { limit?: number }): Promise<
    { tenant: string; sessionId: string; queued: number }[]
  > {
    const res = await this.client.query<{ tenant: string; session_id: string; queued: string | number }>(
      `SELECT tenant, session_id, COUNT(*) AS queued
       FROM everdict_agent_inbox WHERE disposition = 'queued'
       GROUP BY tenant, session_id
       ORDER BY MIN(seq) ASC
       LIMIT $1`,
      [opts?.limit ?? 500],
    );
    return res.rows.map((row) => ({ tenant: row.tenant, sessionId: row.session_id, queued: Number(row.queued) }));
  }

  // ONE conditional UPDATE, not a SELECT followed by a write: two replicas (or a wake racing a turn
  // boundary) selecting the same queued rows would otherwise both absorb them, and the instruction would be
  // delivered twice. `RETURNING` in seq order is the claim AND the read — whoever wins gets the rows, the
  // loser gets none.
  private async settleInbox(
    tenant: string,
    sessionId: string,
    disposition: "delivered" | "discarded",
    at: string,
  ): Promise<AgentInboxEntry[]> {
    const res = await this.client.query<InboxRow>(
      `UPDATE everdict_agent_inbox SET disposition = $4, settled_at = $3
       WHERE tenant = $1 AND session_id = $2 AND disposition = 'queued'
       RETURNING ${INBOX_COLUMNS}`,
      [tenant, sessionId, at, disposition],
    );
    return [...res.rows].sort((a, b) => Number(a.seq) - Number(b.seq)).map(inboxRowToEntry);
  }
}
