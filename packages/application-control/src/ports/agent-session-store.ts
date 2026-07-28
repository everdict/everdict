import type { AgentMessageRecord, AgentPermissionMode, AgentRunStatus, AgentSessionRecord } from "@everdict/contracts";

// Persistence for Everdict's own agent conversations. Sessions are owner-scoped (a member's own chat history)
// within a workspace; messages form an append-only, seq-ordered transcript per session. async — Postgres honors
// the same contract. See docs/architecture/agent-conversations.md.
export interface AgentSessionStore {
  createSession(record: AgentSessionRecord): Promise<void>;
  getSession(tenant: string, owner: string, id: string): Promise<AgentSessionRecord | undefined>;
  // Visibility-aware lookup: the session when `subject` is its owner OR it is workspace-visible
  // (visibility === "workspace", e.g. a comment-thread discussion session any member may read/continue).
  // The owner path behaves exactly like getSession; owner-only surfaces (list/rename/delete) keep getSession.
  getVisibleSession(tenant: string, subject: string, id: string): Promise<AgentSessionRecord | undefined>;
  // Newest first (updatedAt descending) — the owner's own sessions in this workspace.
  listSessions(tenant: string, owner: string): Promise<AgentSessionRecord[]>;
  // Bump updatedAt (activity) and optionally set the title (e.g. first user message → session title).
  touchSession(tenant: string, id: string, updatedAt: string, title?: string): Promise<void>;
  // Set the conversation's model override (null clears it → falls back to the workspace/server default) and bump updatedAt.
  setSessionModel(tenant: string, id: string, model: string | null, updatedAt: string): Promise<void>;
  // Set the conversation's standing permission mode (null clears it → "default": ask for every mutation) and bump updatedAt.
  setSessionPermissionMode(
    tenant: string,
    id: string,
    mode: AgentPermissionMode | null,
    updatedAt: string,
  ): Promise<void>;
  // Headless-run lifecycle transition (agent-automation A4) — owned by the agent service's activation wrapper.
  setSessionStatus(tenant: string, id: string, status: AgentRunStatus, updatedAt: string): Promise<void>;
  // Durable activation dedup (agent-automation A3): has this crafted agent already run for this platform event?
  // At-least-once delivery (push + reconcile) collapses here, surviving agent-service restarts.
  hasTriggerSession(tenant: string, agentId: string, eventId: string): Promise<boolean>;
  deleteSession(tenant: string, owner: string, id: string): Promise<void>;
  appendMessages(records: AgentMessageRecord[]): Promise<void>;
  // Oldest first (seq ascending). With sinceSeq, only messages whose seq is strictly greater (polling).
  listMessages(tenant: string, sessionId: string, sinceSeq?: number): Promise<AgentMessageRecord[]>;
}
