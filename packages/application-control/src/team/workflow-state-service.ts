import {
  BadRequestError,
  ConflictError,
  DEFAULT_WORKFLOW_STATES,
  type IssueStatus,
  NotFoundError,
  type WorkflowStateColor,
  type WorkflowStateRecord,
} from "@everdict/contracts";
import type { IssueStore } from "../ports/issue-store.js";
import type { WorkflowStateStore } from "../ports/workflow-state-store.js";

// A team's named workflow states (docs/tracker.md). The canonical status vocabulary stays closed; a state is a
// NAMED VIEW onto it, so renaming a column can never reach the release gate. This service owns the two rules
// that keeps true: every state declares a canonical status, and a state still holding issues cannot vanish.

export interface CreateWorkflowStateInput {
  tenant: string;
  teamId: string;
  name: string;
  description?: string;
  status: IssueStatus;
  color: WorkflowStateColor;
}

export interface WorkflowStateServiceDeps {
  store: WorkflowStateStore;
  // Read-only: the delete gate counts what the state still holds, and a removal re-points those issues.
  issues: IssueStore;
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

  // Called when a team is created, and idempotently on the list path — a team that has no board yet gets one
  // rather than an empty settings screen, the same repair `ensureDefault` does for the default team.
  async ensureDefaults(tenant: string, teamId: string): Promise<WorkflowStateRecord[]> {
    const existing = await this.deps.store.listByTeam(tenant, teamId);
    if (existing.length > 0) return existing;
    const now = this.now();
    const seeded: WorkflowStateRecord[] = DEFAULT_WORKFLOW_STATES.map((state, position) => ({
      id: this.newId(),
      tenant,
      teamId,
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

  list(tenant: string, teamId: string): Promise<WorkflowStateRecord[]> {
    return this.ensureDefaults(tenant, teamId);
  }

  async get(tenant: string, id: string): Promise<WorkflowStateRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { state: id }, `workflow state '${id}' not found.`);
    return record;
  }

  async create(input: CreateWorkflowStateInput): Promise<WorkflowStateRecord> {
    // `regressed` is not a state a team can add: an issue reaches it only by falling from a resolution, never by
    // somebody dragging a card into a column.
    if (input.status === "regressed")
      throw new BadRequestError(
        "BAD_REQUEST",
        { status: input.status },
        "`regressed` is reached by a resolution falling, not by moving a card — it cannot be a board column.",
      );
    const siblings = await this.ensureDefaults(input.tenant, input.teamId);
    if (siblings.some((state) => state.name.toLowerCase() === input.name.trim().toLowerCase()))
      throw new ConflictError(
        "CONFLICT",
        { team: input.teamId, name: input.name },
        "This team already has a state with that name.",
      );
    const now = this.now();
    const record: WorkflowStateRecord = {
      id: this.newId(),
      tenant: input.tenant,
      teamId: input.teamId,
      name: input.name.trim(),
      ...(input.description !== undefined ? { description: input.description } : {}),
      status: input.status,
      color: input.color,
      // At the end of the board — a new column is the team's newest step, and where it belongs is a reorder.
      position: siblings.reduce((max, state) => Math.max(max, state.position + 1), 0),
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.create(record);
    return record;
  }

  // Renaming, recolouring and reordering are the point of the feature. The canonical `status` may also change —
  // a team that decides its "In QA" column is really review, not progress — which MOVES every issue in it, so
  // the service re-stamps them rather than letting the board and the record disagree.
  async update(
    tenant: string,
    id: string,
    fields: {
      name?: string;
      description?: string | null;
      color?: WorkflowStateColor;
      position?: number;
      status?: IssueStatus;
    },
  ): Promise<WorkflowStateRecord> {
    const record = await this.get(tenant, id);
    if (fields.status === "regressed")
      throw new BadRequestError(
        "BAD_REQUEST",
        { status: fields.status },
        "`regressed` is reached by a resolution falling, not by moving a card — it cannot be a board column.",
      );
    if (fields.name !== undefined) {
      const siblings = await this.deps.store.listByTeam(tenant, record.teamId);
      if (siblings.some((state) => state.id !== id && state.name.toLowerCase() === fields.name?.trim().toLowerCase()))
        throw new ConflictError(
          "CONFLICT",
          { team: record.teamId, name: fields.name },
          "This team already has a state with that name.",
        );
    }
    const now = this.now();
    const updated = await this.deps.store.update(tenant, id, {
      ...(fields.name !== undefined ? { name: fields.name.trim() } : {}),
      ...(fields.description !== undefined
        ? { description: fields.description === null ? undefined : fields.description }
        : {}),
      ...(fields.color !== undefined ? { color: fields.color } : {}),
      ...(fields.position !== undefined ? { position: fields.position } : {}),
      ...(fields.status !== undefined ? { status: fields.status } : {}),
      updatedAt: now,
    });
    if (!updated) throw new NotFoundError("NOT_FOUND", { state: id }, `workflow state '${id}' not found.`);
    if (fields.status !== undefined && fields.status !== record.status) {
      const held = await this.deps.issues.list(tenant, { stateId: id });
      for (const issue of held)
        await this.deps.issues.update(tenant, issue.id, { status: fields.status, updatedAt: now });
    }
    return updated;
  }

  // A state still holding issues cannot vanish — the issues would name a column that no longer exists. Moving
  // them somewhere is the member's decision, so the refusal names the count (the same gate a project has).
  async remove(tenant: string, id: string): Promise<void> {
    const record = await this.get(tenant, id);
    const held = await this.deps.issues.list(tenant, { stateId: id, limit: 1 });
    if (held.length > 0)
      throw new ConflictError(
        "CONFLICT",
        { state: id },
        "This state still holds issues — move them to another state first.",
      );
    const siblings = await this.deps.store.listByTeam(tenant, record.teamId);
    if (siblings.length <= 1)
      throw new ConflictError("CONFLICT", { team: record.teamId }, "A team keeps at least one workflow state.");
    await this.deps.store.remove(tenant, id);
  }

  // "Which state does an issue in this canonical status belong to" — the fallback for an issue that names none
  // (every issue that predates the board, and every one the regression watch moved).
  async defaultFor(tenant: string, teamId: string, status: IssueStatus): Promise<WorkflowStateRecord | undefined> {
    const states = await this.ensureDefaults(tenant, teamId);
    return states.find((state) => state.status === status);
  }
}
