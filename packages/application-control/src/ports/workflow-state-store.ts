import type { WorkflowStateRecord } from "@everdict/contracts";

// The workspace's named workflow states. No outbox: seeding a board is not workspace news — the canonical status
// vocabulary those states map onto is what every fact already carries. `create` is the seed's write; nothing
// renames, re-maps or removes a state.
export interface WorkflowStateStore {
  create(record: WorkflowStateRecord): Promise<void>;
  get(tenant: string, id: string): Promise<WorkflowStateRecord | undefined>;
  // The workspace's board, in position order — a workflow is a sequence.
  listByTenant(tenant: string): Promise<WorkflowStateRecord[]>;
}
