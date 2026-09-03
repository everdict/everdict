import type { WorkflowStateRecord } from "@everdict/contracts";

// A team's named workflow states. No outbox: renaming a column is not workspace news — the canonical status
// vocabulary those states map onto is what every fact already carries.
export interface WorkflowStateStore {
  create(record: WorkflowStateRecord): Promise<void>;
  get(tenant: string, id: string): Promise<WorkflowStateRecord | undefined>;
  // Board order, always — a workflow is a sequence.
  // The workspace's board, in position order. Was `listByTeam` — a column belonged to a team, and there is
  // one board now.
  listByTenant(tenant: string): Promise<WorkflowStateRecord[]>;
  update(tenant: string, id: string, patch: Partial<WorkflowStateRecord>): Promise<WorkflowStateRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
