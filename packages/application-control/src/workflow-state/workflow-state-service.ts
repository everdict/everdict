import { DEFAULT_WORKFLOW_STATES, type WorkflowStateRecord } from "@everdict/contracts";
import type { WorkflowStateStore } from "../ports/workflow-state-store.js";

// The workspace's named workflow states (docs/tracker.md). The canonical status vocabulary stays closed; a state is a
// NAMED VIEW onto it, so what a column is called can never reach the release gate. The board is read-only: a
// workspace uses what `ensureDefaults` seeded, and the columns a workspace added before the editor went away stay
// readable.

export interface WorkflowStateServiceDeps {
  store: WorkflowStateStore;
  newId?: () => string;
  now?: () => string;
}

export class WorkflowStateService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: WorkflowStateServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // Idempotent on the list path — a workspace that has no board yet gets one rather than an empty board.
  async ensureDefaults(tenant: string): Promise<WorkflowStateRecord[]> {
    const existing = await this.deps.store.listByTenant(tenant);
    if (existing.length > 0) return existing;
    const now = this.now();
    const seeded: WorkflowStateRecord[] = DEFAULT_WORKFLOW_STATES.map((state, position) => ({
      id: this.newId(),
      tenant,
      name: state.name,
      status: state.status,
      color: state.color,
      position,
      createdAt: now,
      updatedAt: now,
    }));
    for (const state of seeded) await this.deps.store.create(state);
    return seeded;
  }

  list(tenant: string): Promise<WorkflowStateRecord[]> {
    return this.ensureDefaults(tenant);
  }
}
