import type { AgentTaskRecord } from "@everdict/contracts";

// Persistence for the workspace task ledger (docs/architecture/agent-teams.md) — workspace-shared coordination
// tasks members and agents create, claim, chain (blockedBy) and complete. No visibility tiers: a coordination
// ledger only coordinates what everyone can see. async — Postgres honors the same contract.
export interface AgentTaskStore {
  create(record: AgentTaskRecord): Promise<void>;
  get(tenant: string, id: string): Promise<AgentTaskRecord | undefined>;
  // Newest first (updatedAt descending); optional status filter for the common "what's open" read.
  list(tenant: string, opts?: { status?: AgentTaskRecord["status"]; limit?: number }): Promise<AgentTaskRecord[]>;
  update(tenant: string, id: string, patch: Partial<AgentTaskRecord>): Promise<AgentTaskRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
