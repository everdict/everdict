import type { AgentMessageRecord, AgentSessionRecord } from "@everdict/contracts";

// Persistence for Everdict's own agent conversations. Sessions are owner-scoped (a member's own chat history)
// within a workspace; messages form an append-only, seq-ordered transcript per session. async — Postgres honors
// the same contract. See docs/architecture/agent-conversations.md.
export interface AgentSessionStore {
  createSession(record: AgentSessionRecord): Promise<void>;
  getSession(tenant: string, owner: string, id: string): Promise<AgentSessionRecord | undefined>;
  // Newest first (updatedAt descending) — the owner's own sessions in this workspace.
  listSessions(tenant: string, owner: string): Promise<AgentSessionRecord[]>;
  // Bump updatedAt (activity) and optionally set the title (e.g. first user message → session title).
  touchSession(tenant: string, id: string, updatedAt: string, title?: string): Promise<void>;
  // Set the conversation's model override (null clears it → falls back to the workspace/server default) and bump updatedAt.
  setSessionModel(tenant: string, id: string, model: string | null, updatedAt: string): Promise<void>;
  deleteSession(tenant: string, owner: string, id: string): Promise<void>;
  appendMessages(records: AgentMessageRecord[]): Promise<void>;
  // Oldest first (seq ascending). With sinceSeq, only messages whose seq is strictly greater (polling).
  listMessages(tenant: string, sessionId: string, sinceSeq?: number): Promise<AgentMessageRecord[]>;
}
