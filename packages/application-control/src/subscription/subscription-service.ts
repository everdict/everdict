import {
  type AgentTrigger,
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
  // The trigger-relocation seam (E3's last rung): read each tenant-owned agent's spec triggers, and clear
  // them (a new immutable spec version with triggers: []) once their subscriptions exist. Wired by the
  // composition root from the agent registry + save flow; absent = import unavailable.
  agentTriggerSource?: {
    list(tenant: string): Promise<Array<{ id: string; triggers: AgentTrigger[] }>>;
    clearTriggers(tenant: string, agentId: string): Promise<void>;
  };
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

  // Relocate agent-spec triggers into the registry (event-plumbing E3 §6, the deliberate last rung): one
  // subscription per spec trigger (same selector grammar — a verbatim copy), then the spec's own copy is
  // CLEARED so exactly one source matches. Idempotent: an already-identical rule is skipped, an agent with
  // no triggers is untouched, and a re-run after a partial failure resumes where it stopped.
  async importAgentTriggers(tenant: string, createdBy: string): Promise<{ imported: number; agents: string[] }> {
    const source = this.deps.agentTriggerSource;
    if (!source) throw new NotFoundError("NOT_FOUND", {}, "trigger import is not configured.");
    const agents = await source.list(tenant);
    const existing = await this.deps.store.list(tenant);
    let imported = 0;
    const relocated: string[] = [];
    for (const agent of agents) {
      if (agent.triggers.length === 0) continue;
      for (const trigger of agent.triggers) {
        const duplicate = existing.some(
          (rule) =>
            rule.reaction.kind === "agent" &&
            rule.reaction.agentId === agent.id &&
            sameSelector(rule.selector, trigger),
        );
        if (duplicate) continue;
        await this.create({
          tenant,
          createdBy,
          name: triggerRuleName(agent.id, trigger),
          selector: { kinds: trigger.kinds, filters: trigger.filters },
          reaction: { kind: "agent", agentId: agent.id },
        });
        imported++;
      }
      await source.clearTriggers(tenant, agent.id);
      relocated.push(agent.id);
    }
    return { imported, agents: relocated };
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

function sameSelector(a: SubscriptionSelector, b: AgentTrigger): boolean {
  const kinds = (list: readonly string[]) => [...list].sort().join(",");
  if (kinds(a.kinds) !== kinds(b.kinds)) return false;
  const filters = (list: readonly AgentTrigger["filters"][number][]) =>
    JSON.stringify([...list].sort((x, y) => x.field.localeCompare(y.field)));
  return filters(a.filters) === filters(b.filters);
}

function triggerRuleName(agentId: string, trigger: AgentTrigger): string {
  const head = trigger.kinds[0] ?? "events";
  const extra = trigger.kinds.length > 1 ? ` +${trigger.kinds.length - 1}` : "";
  return `${agentId} — ${head}${extra}`.slice(0, 120);
}
