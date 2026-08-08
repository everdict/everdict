import { type DomainFact, type IssueLabelColor, type IssueLabelRecord, NotFoundError } from "@everdict/contracts";
import { IssueLabel, type IssueLabelEditInput } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { IssueLabelStore } from "../ports/issue-label-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { OutboxEvent } from "../ports/run-store.js";

// The label registry's use-cases (docs/tracker.md). Same shape as the issue service: every mutation funnels
// through one place that turns a domain transition into stamped facts + a same-tx outbox write, so no transport
// can define a label without the workspace hearing about it.

export interface IssueLabelActor {
  subject: string;
}

export interface CreateIssueLabelInput {
  tenant: string;
  name: string;
  color: IssueLabelColor;
  description?: string;
}

export interface IssueLabelServiceDeps {
  labels: IssueLabelStore;
  // Nudges the live consumers (feed, agent triggers) after the same-tx outbox write — best-effort by contract.
  events?: PlatformEventEmitter;
  now?: () => string;
  newId?: () => string;
}

export class IssueLabelService {
  private readonly labels: IssueLabelStore;
  private readonly events: PlatformEventEmitter | undefined;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(deps: IssueLabelServiceDeps) {
    this.labels = deps.labels;
    this.events = deps.events;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => `lbl_${crypto.randomUUID()}`);
  }

  async list(tenant: string): Promise<IssueLabelRecord[]> {
    return this.labels.list(tenant);
  }

  async get(tenant: string, id: string): Promise<IssueLabelRecord> {
    const record = await this.labels.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { label: id }, "That label does not exist.");
    return record;
  }

  async create(input: CreateIssueLabelInput, actor: IssueLabelActor): Promise<IssueLabelRecord> {
    const record = IssueLabel.newLabel({
      id: this.newId(),
      tenant: input.tenant,
      name: input.name,
      color: input.color,
      ...(input.description !== undefined ? { description: input.description } : {}),
      createdBy: actor.subject,
      now: this.now(),
    });
    // The store rejects a duplicate name (ConflictError) — uniqueness is a concurrency property, not a rule the
    // aggregate could enforce from the one record it can see.
    await this.persist(input.tenant, IssueLabel.creationFacts(record), (outbox) => this.labels.create(record, outbox));
    return record;
  }

  async update(
    tenant: string,
    id: string,
    fields: IssueLabelEditInput,
    actor: IssueLabelActor,
  ): Promise<IssueLabelRecord> {
    const current = await this.get(tenant, id);
    const transition = IssueLabel.from(current).update(fields, actor.subject, this.now());
    if (transition.facts.length === 0) return current; // nothing actually changed
    const next = await this.persist(tenant, transition.facts, (outbox) =>
      this.labels.update(tenant, id, transition.patch, outbox),
    );
    if (!next) throw new NotFoundError("NOT_FOUND", { label: id }, "That label does not exist.");
    return next;
  }

  // Deleting strips the id from every issue that wears it, in the store's own transaction — see IssueLabelStore.
  async remove(tenant: string, id: string, actor: IssueLabelActor): Promise<void> {
    const current = await this.get(tenant, id);
    const facts = IssueLabel.from(current).deletionFacts(actor.subject);
    await this.persist(tenant, facts, (outbox) => this.labels.remove(tenant, id, outbox));
  }

  // Stamp → persist (state + facts in ONE transaction) → nudge the live consumers. The ONE place a label
  // transition becomes durable, so no caller can define a label without the workspace hearing about it.
  private async persist<T>(
    tenant: string,
    facts: DomainFact[],
    write: (outbox: OutboxEvent[]) => Promise<T>,
  ): Promise<T> {
    const stamped = stampFacts(tenant, facts, { newId: this.newId, now: this.now });
    const result = await write(stamped.map((s) => s.record));
    if (stamped.length > 0) void this.events?.pushPersisted?.(stamped);
    return result;
  }

  async usageCount(tenant: string, id: string): Promise<number> {
    return this.labels.usageCount(tenant, id);
  }

  // Map label NAMES onto the registry, defining what is missing. This is the seam a GitHub import needs: the
  // remote owns labels by name, so every pull arrives with strings that have to become ids before the pure
  // aggregate ever sees them. Creating-on-miss is deliberate — dropping an unknown remote label would silently
  // lose classification the source of record considers real.
  async resolveNames(tenant: string, names: string[], actor: IssueLabelActor): Promise<string[]> {
    const ids: string[] = [];
    for (const raw of names) {
      const name = raw.trim();
      if (name.length === 0) continue;
      const existing = await this.labels.getByName(tenant, name);
      if (existing) {
        if (!ids.includes(existing.id)) ids.push(existing.id);
        continue;
      }
      try {
        // Imported labels land neutral; a member recolours them from Settings › Labels. Guessing a colour from
        // the name would be inventing meaning GitHub never sent.
        const created = await this.create({ tenant, name, color: "gray" }, actor);
        if (!ids.includes(created.id)) ids.push(created.id);
      } catch {
        // Lost a race with a concurrent import that defined the same name — re-read and use theirs.
        const raced = await this.labels.getByName(tenant, name);
        if (raced && !ids.includes(raced.id)) ids.push(raced.id);
      }
    }
    return ids;
  }
}
