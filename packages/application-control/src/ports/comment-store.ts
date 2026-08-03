import type { CommentAgentStatus, CommentRecord } from "@everdict/contracts";

// Lifecycle patch for an agent-authored comment (running placeholder → final answer). Dumb persistence —
// the service owns the semantics. agentActivity: null clears the "doing now" line (terminal states).
export interface CommentUpdatePatch {
  body?: string;
  agentStatus?: CommentAgentStatus;
  agentActivity?: string | null;
}

// One resource's comment total — the shape a list row shows next to a thread icon.
export interface CommentResourceCount {
  resourceId: string;
  count: number;
}

export interface CommentStore {
  add(record: CommentRecord): Promise<void>;
  // Oldest→newest (createdAt ASC) — timeline order. Workspace + resource scoped.
  list(tenant: string, resourceType: string, resourceId: string): Promise<CommentRecord[]>;
  // How many comments each of these resources carries, in ONE aggregate. This is what a LIST screen needs: the
  // number, for many rows at once. Counting via `list` per row would be a query per row — the defect the issue
  // list was just rebuilt to remove. A resource with no comments simply has no entry.
  countByResource(tenant: string, resourceType: string, resourceIds: string[]): Promise<CommentResourceCount[]>;
  get(tenant: string, id: string): Promise<CommentRecord | undefined>;
  // Patch an agent comment's lifecycle fields (only agent comments are ever updated — member comments are immutable).
  update(tenant: string, id: string, patch: CommentUpdatePatch, updatedAt: string): Promise<void>;
  // Cross-tenant sweep input: agent comments still running/awaiting_approval whose updatedAt is older than the
  // cutoff — their lifecycle callbacks died (agent crash / severed trigger). The service marks them failed.
  listStuckAgentAnswers(updatedBefore: string): Promise<CommentRecord[]>;
  remove(tenant: string, id: string): Promise<void>;
}
