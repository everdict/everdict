import {
  ForbiddenError,
  NotFoundError,
  type SubscriptionGovernance,
  type SubscriptionReaction,
  type SubscriptionRecord,
  type SubscriptionSelector,
} from "@everdict/contracts";
import type { SubscriptionStore } from "../ports/subscription-store.js";

// Subscription registry CRUD (event-plumbing.md E3 §6) — workspace-scoped automation config: selector
// (kinds + filters) → reaction (agent | webhook | workflow) under governance (enabled + cooldown).
// Edit/delete = creator or admin (the Views posture); reaction targets that name an agent are validated
// against the tenant registry through the injected resolver, so a subscription never points at nothing.

export interface CreateSubscriptionInput {
  tenant: string;
  createdBy: string;
  name: string;
  selector: SubscriptionSelector;
  reaction: SubscriptionReaction;
  governance?: SubscriptionGovernance;
}

export interface UpdateSubscriptionInput {
  name?: string;
  selector?: SubscriptionSelector;
  reaction?: SubscriptionReaction;
  governance?: SubscriptionGovernance;
}

export interface SubscriptionServiceDeps {
  store: SubscriptionStore;
  // Cross-store read behind a function, not a registry dep: does this agent id exist in the tenant registry?
  agentExists?: (tenant: string, agentId: string) => Promise<boolean>;
  newId?: () => string;
  now?: () => string;
}

export class SubscriptionService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: SubscriptionServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateSubscriptionInput): Promise<SubscriptionRecord> {
    await this.assertAgentTargets(input.tenant, input.reaction);
    const ts = this.now();
    const record: SubscriptionRecord = {
      id: this.newId(),
      tenant: input.tenant,
      name: input.name,
      selector: input.selector,
      reaction: input.reaction,
      governance: input.governance ?? { enabled: true },
      createdBy: input.createdBy,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    return record;
  }

  list(tenant: string): Promise<SubscriptionRecord[]> {
    return this.deps.store.list(tenant);
  }

  async get(tenant: string, id: string): Promise<SubscriptionRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `subscription '${id}' not found.`);
    return record;
  }

  async update(
    tenant: string,
    id: string,
    patch: UpdateSubscriptionInput,
    actor: { subject: string; isAdmin: boolean },
  ): Promise<SubscriptionRecord> {
    const existing = await this.get(tenant, id);
    if (existing.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id },
        "You are not allowed to edit this subscription (creator or workspace admin only).",
      );
    if (patch.reaction !== undefined) await this.assertAgentTargets(tenant, patch.reaction);
    const updated = await this.deps.store.update(tenant, id, { ...patch, updatedAt: this.now() });
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `subscription '${id}' not found.`);
    return updated;
  }

  async remove(tenant: string, id: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const existing = await this.get(tenant, id);
    if (existing.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id },
        "You are not allowed to delete this subscription (creator or workspace admin only).",
      );
    await this.deps.store.remove(tenant, id);
  }

  private async assertAgentTargets(tenant: string, reaction: SubscriptionReaction): Promise<void> {
    if (!this.deps.agentExists) return;
    const agentIds =
      reaction.kind === "agent"
        ? [reaction.agentId]
        : reaction.kind === "workflow"
          ? reaction.steps.map((step) => step.agentId)
          : [];
    for (const agentId of agentIds) {
      if (!(await this.deps.agentExists(tenant, agentId)))
        throw new NotFoundError("NOT_FOUND", { agentId }, `agent '${agentId}' not found in this workspace.`);
    }
  }
}
